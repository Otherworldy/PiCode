import type { HostedSession } from "@zcode/pi-host";
import type { ZCodeApp } from "../app/types.js";
import type {
  ZCodeProtocolAgentDependencies,
  ZCodeProtocolAgentServerContext,
} from "./server-types.js";

/** 创建、恢复与绑定共用同一个关闭等待边界；测试嵌入宿主仍可直接执行。 */
export async function withSessionCreation<T>(
  context: Pick<ZCodeProtocolAgentServerContext, "runSessionCreation" | "assertServing">,
  create: () => Promise<T>,
): Promise<T> {
  context.assertServing?.();
  return context.runSessionCreation ? context.runSessionCreation(create) : create();
}

/** 持有 app 资源而非业务 session；临时 workspace app、尚未登记的 app 也归此 owner。 */
export class ProtocolRuntimeResources {
  private stopping = false;
  private readonly hosted = new Set<HostedSession>();
  private readonly apps = new Set<ZCodeApp>();
  private readonly creations = new Set<Promise<void>>();
  private closePromise?: Promise<void>;

  constructor(private readonly factory: ZCodeProtocolAgentDependencies["createZCodeApp"]) {}

  readonly create: ZCodeProtocolAgentDependencies["createZCodeApp"] = (options) =>
    this.runSessionCreation(async () => {
      const app = await this.factory(options);
      const originalClose = app.close?.bind(app);
      let closing: Promise<void> | undefined;
      app.close = () => {
        closing ??= Promise.resolve().then(async () => {
          try {
            await originalClose?.();
          } finally {
            this.apps.delete(app);
          }
        });
        return closing;
      };
      this.apps.add(app);
      if (this.stopping) {
        // create 在 EOF 前开始、EOF 后返回时不能重新成为可用 session，也不能遗失资源。
        await this.stopApp(app);
        this.assertServing();
      }
      return app;
    });

  async trackHosted(hosted: HostedSession): Promise<void> {
    if (!this.hosted.has(hosted)) {
      const dispose = hosted.dispose.bind(hosted);
      let closing: Promise<void> | undefined;
      hosted.dispose = () =>
        (closing ??= Promise.resolve().then(async () => {
          try {
            await dispose();
          } finally {
            this.hosted.delete(hosted);
          }
        }));
      this.hosted.add(hosted);
    }
    if (this.stopping) {
      await hosted.dispose();
      this.assertServing();
    }
  }

  async runSessionCreation<T>(create: () => Promise<T>): Promise<T> {
    this.assertServing();
    // 在运行 factory 前登记，shutdown 才能等待尚未返回实例的创建和失败释放。
    const operation = Promise.resolve().then(create);
    const drained = operation.then(
      () => undefined,
      () => undefined,
    );
    this.creations.add(drained);
    void drained.then(() => this.creations.delete(drained));
    return operation;
  }

  assertServing(): void {
    if (this.stopping) throw new Error("PiCode Protocol runtime is stopping");
  }

  close(): Promise<void> {
    this.stopping = true;
    this.closePromise ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled(
        [...this.creations].concat(
          [...this.apps]
            .map((app) => this.stopApp(app))
            .concat(
              [...this.hosted].map(async (hosted) => {
                await hosted.dispose();
              }),
            ),
        ),
      );
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Protocol apps shutdown failed");
    });
    return this.closePromise;
  }

  private async stopApp(app: ZCodeApp): Promise<void> {
    try {
      app.runtime.beginShutdown();
      app.runtime.stopActiveForegroundExecution?.({ reason: "Protocol runtime stopping" });
    } finally {
      await app.close?.();
    }
  }
}

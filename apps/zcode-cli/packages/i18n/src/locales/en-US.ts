import type { ZCodeCopy } from "../types.js";

export const enUS: ZCodeCopy = {
  locale: "en-US",
  cli: {
    errors: {
      localeUnsupported: (value) =>
        `Unsupported --locale value: ${value}. Supported locales: en-US, zh-CN, auto.`,
    },
    help: (version) => `zcode ${version}

Usage:
  zcode [command] [options]

With no command, zcode prints this help. Use the PiCode app, or app-server --stdio.

Commands:
  app-server  Run the PiCode Protocol stdio app server
  commands    List custom slash commands (\`commands list\`)
  doctor      Inspect runtime and packaging
  hooks       Inspect or grant workspace hook trust
  plugins     Manage plugins and marketplaces (alias: plugin)
  version     Print the CLI version

Options:
  -h, --help       Show help
  -v, --version    Show version
  --cwd <path>     Run from the given directory
  --locale <locale>  UI locale: en-US, zh-CN, or auto
  --json           Print machine-readable JSON where supported
  --no-color       Disable color
  --verbose        Print extra diagnostics
`,
  },
  tui: {
    copy: {
      copied: "Copied selected text to clipboard.",
      failed: "Could not copy selected text.",
      unavailable: "Text clipboard copy is not available in this terminal.",
    },
    effort: {
      disabled: "disabled",
      enabled: "enabled",
    },
    input: {
      activeStatusHint: "esc to interrupt",
      busyPlaceholder: "Type to queue input",
      placeholder: "Type a prompt",
      queuedMore: (count) => `+ ${count} more queued`,
      queuedSubmitHint: "Submitted after the next tool call.",
      queuedTitle: (count) => ` Queue (${count}) `,
      title: "Input",
      noHistorySource: "No input history source is configured.",
      noPreviousInput: "No previous input for this project.",
      restoredPreviousInput: "Restored previous input.",
      restoredPreviousInputWithAttachments: (count) =>
        `Restored previous input with ${count} attachment(s).`,
      restorePreviousInputFailed: "Could not restore previous input.",
      typePrompt: "Type a question and press Enter.",
    },
    loginRequired: {
      help: "Use /model to view models, or /login to connect a Coding Plan account.",
      message: "No available models. Configure a provider or sign in with /login.",
      status: "No available models. Configure a provider or sign in with /login.",
      title: "model setup required",
    },
    loginSetup: {
      emptyMessage: "No login options are available.",
      help: "Use Up/Down to choose, Enter to select.",
      options: {
        bigmodelApiKey: {
          inputPrimary: "Enter BigModel Coding Plan API Key",
          inputSecondary: "Paste the key here. It is hidden while typing.",
          primary: "BigModel Coding Plan API Key",
          secondary: "Paste a Coding Plan API key manually.",
        },
        bigmodelOauth: {
          pendingPrimary: "Waiting for BigModel authorization",
          pendingSecondary:
            "Complete sign-in in your browser. Authorization is detected automatically.",
          primary: "BigModel Coding Plan",
          secondary: "Open browser login; authorization is detected automatically.",
        },
        zaiApiKey: {
          inputPrimary: "Enter Z.AI Coding Plan API Key",
          inputSecondary: "Paste the key here. It is hidden while typing.",
          primary: "Z.AI Coding Plan API Key",
          secondary: "Paste a Coding Plan API key manually.",
        },
        zaiOauth: {
          pendingPrimary: "Waiting for Z.AI authorization",
          pendingSecondary:
            "Complete sign-in in your browser. I will continue when authorization finishes.",
          primary: "Z.AI Coding Plan",
          secondary: "Open browser login and create a Coding Plan API key.",
        },
      },
      pending: {
        cancelStatus: "Login cancelled. Choose a setup method.",
        help: "Esc cancels and returns to setup choices.",
        status: "Waiting for browser authorization...",
      },
      input: {
        cancelStatus: "API key entry cancelled. Choose a setup method.",
        clearStatus: "API key input cleared.",
        emptyStatus: "API key is required.",
        help: "Enter saves the key. Esc returns to setup choices.",
        placeholder: "Paste API key",
        status: "Enter the API key, then press Enter.",
        submitStatus: "Saving API key...",
      },
      prompt: "Choose a login or API key setup method.",
      response: "Choose how to set up a Coding Plan provider.",
      title: "Set Up Coding Plan",
    },
    model: {
      requestFailed: (message) => `Model request failed: ${message}`,
      responseReceived: "Model response received.",
      responseReceivedWithTokens: (tokens) => `Model response received. ${tokens} tokens.`,
      retryScheduled: ({ attempt, delay, maxAttempts, reason }) =>
        `Retrying model request ${attempt}/${Math.max(1, maxAttempts - 1)} in ${delay}: ${reason}`,
      streamStalled: "Model stream stalled.",
    },
    sidebar: {
      subagents: {
        title: "Subagents",
        empty: "No subagents yet.",
        emptyOutput: "No output yet.",
        back: "← Main conversation",
        readonly: "Read-only · Esc to return",
        loading: "Loading subagent output...",
        unavailable: "Subagent output unavailable.",
        retry: "Retry",
        more: "Load more",
        pendingMain: "Main conversation needs your input — return to respond",
        ended: (count) => `Ended (${count})`,
        status: {
          running: "running",
          waiting: "waiting",
          blocked: "blocked",
          success: "completed",
          failed: "failed",
          cancelled: "cancelled",
          lost: "lost",
        },
      },
      api: {
        empty: "No API calls yet.",
        model: "Model",
        more: (count) => `+${count} more`,
        requests: "Requests",
        server: "Server",
      },
      cache: {
        hit: "hit",
        lastHit: "last hit",
        lastMiss: "last miss",
        readWrite: ({ read, write }) => `${read} read / ${write} write`,
        total: "total",
      },
      context: {
        cache: "Cache",
        cacheReadWrite: "Cache R/W",
        inputOutput: "I/O",
        reason: "Reason",
        tokens: "Tokens",
        used: "Used",
        window: "Window",
      },
      modifiedFiles: {
        empty: "No file changes yet.",
        more: (count) => `+${count} more`,
      },
      mcp: {
        empty: "No MCP servers configured.",
        loadFailed: "MCP status unavailable.",
        loading: "Loading MCP status...",
        more: (count) => `+${count} more`,
        servers: "Servers",
        status: {
          connected: "connected",
          connecting: "connecting",
          disabled: "disabled",
          disconnected: "disconnected",
          failed: "failed",
          untrusted: "untrusted",
        },
        summary: ({ connected, total }) => `${connected}/${total} connected`,
        tools: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
      },
      request: {
        complete: "complete",
        error: "error",
        errorWithStatus: (statusCode) => `error ${statusCode}`,
        pending: "pending",
      },
      status: {
        last: "Last",
      },
      run: {
        draft: "Draft",
        draftChars: (count) => `${count} chars`,
        draftEmpty: "empty",
        messages: "Messages",
        mode: "Mode",
        model: "Model",
        provider: "Provider",
        thought: "Thought",
        trace: "Trace",
        turn: "Turn",
        workspace: "Workspace",
      },
      sections: {
        apis: "APIs",
        context: "Context",
        mcp: "MCP",
        modifiedFiles: "Modified Files",
        run: "Run",
        status: "Status",
        todos: "Todos",
      },
      shellSubtitle: "OpenTUI shell",
      title: "Sidebar",
      todos: {
        empty: "No todos yet.",
        more: (count) => `+${count} more`,
        progress: "Progress",
      },
    },
    status: {
      compactFailed: "Context compression failed.",
      compacted: "Conversation compacted.",
      compacting: "Compressing context...",
      interruptedStreamDiscarded: "Interrupted model stream discarded.",
      modelCalling: "Calling model...",
      permissionRequested: (toolName) => `Permission requested for ${toolName}.`,
      permissionResolved: (toolName) => `Permission resolved for ${toolName}.`,
      ready: "Ready.",
      recoveringStream: "Recovering interrupted model stream...",
      retryingStream: "Retrying model stream...",
      sessionResumed: "Session resumed.",
      targetChanged: (action) => `Target ${action}.`,
      thinking: "Thinking...",
      toolCompleted: (toolName) => `Tool ${toolName} completed.`,
      toolFailed: (toolName) => `Tool ${toolName} failed.`,
      toolPending: (toolName) => `Tool ${toolName} pending.`,
      toolRunning: (toolName) => `Tool ${toolName} running.`,
      turnFailed: "Turn failed.",
    },
    terminal: {
      requiresInteractive: "TUI requires an interactive terminal.",
      starting: "Starting PiCode... Ctrl+C to exit",
    },
    transcript: {
      compact: {
        completed: "Context compressed",
        failed: "Context compression failed",
        interrupted: "Context compression interrupted",
        retry: (command) => `Ctrl-R to retry ${command}`,
        retrying: ({ attempt, maxAttempts }) =>
          maxAttempts > 0
            ? `Retrying context compression (${attempt}/${maxAttempts})`
            : "Retrying context compression",
        skipped: "Context is up to date; no compression needed",
        started: "Compressing context",
      },
      roles: {
        agent: "Agent",
        system: "System",
        user: "User",
      },
      thought: {
        complete: "Thought",
        thinking: "Thinking...",
      },
      title: "Transcript",
      workflow: {
        actors: "actors:",
        actorRow: ({ name, status }) => `${name} - ${status}`,
        usage: ({ spentTokens }) => `usage: ${spentTokens} tokens`,
        collapsed: ({ label, status, nodesSettled, nodesTotal }) =>
          `Workflow ${label} - ${status} (${nodesSettled}/${nodesTotal} steps)`,
        error: (message) => `error: ${message}`,
        expandHint: "+ to expand",
        collapseHint: "- to collapse",
        log: "log:",
        nodes: ({ nodesSettled, nodesTotal }) => `${nodesSettled}/${nodesTotal} steps settled`,
        result: (preview) => `result: ${preview}`,
        status: {
          completed: "completed",
          errored: "errored",
          pending: "pending",
          running: "running",
          stopped: "stopped",
        },
        stopReason: {
          user: "by you",
          model: "by the agent",
          provider: "model error",
          interrupted: "process exited",
          superseded: "superseded by an amended run",
        },
        truncated: "(truncated - full history in the run journal)",
        interruptedNotice: ({ label, runId }) =>
          `Workflow ${label} was interrupted and can be resumed: /dwf resume ${runId}`,
      },
    },
    selection: {
      defaultHelp: "Enter selects, Esc cancels",
      disabled: (reason) => ` [disabled: ${reason}]`,
      filterLine: ({ filter, help }) =>
        `filter: ${filter || "-"} | ${help ?? "Enter selects, Esc cancels"}`,
      noFilter: "-",
    },
    fileMention: {
      empty: "No matching workspace paths.",
      loading: "Loading workspace paths...",
      row: ({ path, selected }) => `${selected ? ">" : " "} ${path}`,
      title: "Files",
    },
    slash: {
      title: "Commands",
      row: ({ name, selected, summary }) => `${selected ? ">" : " "} /${name}  ${summary}`,
    },
  },
};

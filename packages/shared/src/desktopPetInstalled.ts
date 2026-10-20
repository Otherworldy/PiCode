/** 已经下载或本地导入的宠物包。列表由主进程扫描缓存目录与导入记录得到。 */
export interface DesktopPetInstalledPack {
  /** 缓存目录名或本地路径标识。 */
  id: string;
  /** 配置里第一只宠物的名字；没有名字时用压缩包文件名或目录名。 */
  name: string;
  /** 来源类型：下载缓存还是本地导入。 */
  sourceType: "download" | "local";
  /** 下载时记下的地址（download 专用）。选中后写回这个地址。 */
  url?: string;
  /** 本地导入的绝对路径（local 专用）。选中后写回这个目录。 */
  localPath?: string;
  /** 宠物渲染尺寸。 */
  size?: number;
  /** 待机素材绝对路径，用于渲染进程展示待机 WebM。 */
  idleClipPath?: string;
}

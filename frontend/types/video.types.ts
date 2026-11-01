export interface VideoItem {
  id: string;
  filename: string;
  url: string;
  size: number | undefined;
  lastModified: Date | undefined;
}
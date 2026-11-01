export interface PlaylistItem {
  id: string;
  filename: string;
  url: string;
  size_bytes: number;
}

export interface VideoItem {
  id: string | undefined;
  filename: string;
  url: string;
  size: number | undefined;
  lastModified: Date | undefined;
}
export interface QbitTorrentInfo {
  hash: string;
  name: string;
  state?: string;
  progress?: number;
  size?: number;
  total_size?: number;
  completed?: number;
  downloaded?: number;
  uploaded?: number;
  dlspeed?: number;
  upspeed?: number;
  eta?: number;
  num_seeds?: number;
  num_leechs?: number;
  save_path?: string;
  category?: string;
  tags?: string;
  added_on?: number;
  completion_on?: number;
  ratio?: number;
  [key: string]: unknown;
}

export interface QbitTorrentProperties {
  creation_date?: number;
  piece_size?: number;
  comment?: string;
  total_downloaded?: number;
  total_uploaded?: number;
  dl_speed_avg?: number;
  up_speed_avg?: number;
  time_elapsed?: number;
  seeding_time?: number;
}

export interface QbitListOptions {
  filter?: string;
  category?: string;
  tag?: string;
  sort?: string;
  limit?: number;
  hashes?: string[];
}

export interface QbitAddOptions {
  urls?: string[];
  torrents?: Blob[];
  savepath?: string;
  category?: string;
  tags?: string[];
  paused?: boolean;
  skipChecking?: boolean;
}

export interface QbitClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

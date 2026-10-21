declare module 'ffmpeg-static' {
  /** Absolute path to the ffmpeg binary for the current platform. */
  const path: string;
  export = path;
}

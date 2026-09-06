export function parseFFmpegTimeSeconds(line: string): number | null {
  const match = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  if (!match) return null;
  const [, hh, mm, ss] = match;
  return Number(hh) * 3600 + Number(mm) * 60 + Number(ss);
}

export function calculatePercent(currentSeconds: number, duration: number): number {
  return Math.min(100, Math.round((currentSeconds / duration) * 100));
}
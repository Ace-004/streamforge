import { spawn } from "child_process";

export function getVideoInfo(inputPath: string): Promise<{ height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=height:format=duration",
      "-of", "json",
      inputPath,
    ]);

    let output = "";
    let errorOutput = "";

    ffprobe.stdout.on("data", (data) => { output += data; });
    ffprobe.stderr.on("data", (data) => { errorOutput += data; });

    ffprobe.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${errorOutput}`));
      try {
        const parsed = JSON.parse(output);
        const height = parsed.streams[0].height;
        const duration = parseFloat(parsed.format.duration);
        resolve({ height, duration });
      } catch {
        reject(new Error("Failed to parse ffprobe output"));
      }
    });
  });
}
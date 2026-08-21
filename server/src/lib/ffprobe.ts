import { spawn } from "child_process";

export function getVideoHeight(localPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=height",
      "-of",
      "csv=p=0",
      localPath,
    ]);

    let output = "";
    let errorOutput = "";

    ffprobe.stdout.on("data", (data) => {
      output += data;
    });

    ffprobe.stderr.on("data", (data) => {
      errorOutput += data;
    });

    ffprobe.on("close", (code) => {
      if (code === 0) resolve(parseInt(output.trim(), 10));
      else reject(new Error(`ffprobe failed: ${errorOutput}`));
    });
  });
}

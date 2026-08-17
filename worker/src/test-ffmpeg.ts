import {spawn} from 'child_process';

const inputPath = "C:/Users/ayush/Desktop/wall_video.mp4";
const outputPath= "./output-360p.mp4";

const ffmpeg = spawn("ffmpeg",[
  "-i",inputPath,
  "-vf","scale=-2:360",
  "-c:v","libx264",
  "-c:a","aac",
  outputPath,
]);

ffmpeg.stdout.on("data",(data)=>{
  console.log(`stdout: ${data}`);
});

ffmpeg.stderr.on("data", (data)=>{
  console.log(`stderr: ${data}`);
});

ffmpeg.on("close",(code)=>{
  console.log(`FFmpeg process exited with code ${code}`);
});
import dotenv from 'dotenv';
import express from 'express';
dotenv.config();

const app =express();

const PORT=process.env.PORT || 4000;
app.use('/health',async(req,res)=>{
  res.json({status : 'ok'})
})

app.listen(PORT,()=>{
  console.log(`server is running on port ${PORT}`);
})
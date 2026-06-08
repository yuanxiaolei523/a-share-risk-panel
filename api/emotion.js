import { analyzeEmotionCycle } from "../server.js";

export default async function handler(req, res) {
  try {
    const data = await analyzeEmotionCycle();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message || "情绪周期分析失败，请稍后再试。"
    });
  }
}

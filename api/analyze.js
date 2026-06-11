import { analyzeStock, clientErrorMessage } from "../server.js";

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const data = await analyzeStock(url.searchParams);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(data);
  } catch (error) {
    res.status(error.status || 500).json({
      error: clientErrorMessage(error, "分析失败，请稍后再试。")
    });
  }
}

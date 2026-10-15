
import "dotenv/config"
import express from "express"
import cors from "cors"
import { pool } from "./config/db.js"
import budgetRoutes from "./routes/budgetRoutes.js"
import transactionRoutes from "./routes/transactionsRoutes.js"
import savingsGoalRoutes from "./routes/savingsGoalRoutes.js"

const app = express()
const port = Number(process.env.PORT ?? 3001)

app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:5173",
  })
)

app.use(express.json({ limit: "100kb" }))

// Health check dan koneksi database
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1")

    res.json({
      status: "ok",
      database: "connected",
    })
  } catch (error) {
    console.error("Health check gagal:", error)

    res.status(503).json({
      status: "error",
      database: "disconnected",
    })
  }
})

// Route transaksi
app.use("/api/transactions", transactionRoutes)

// Route anggaran
app.use("/api/budgets", budgetRoutes)

app.use("/api/savings-goals", savingsGoalRoutes)

// Middleware 404 harus diletakkan setelah semua route
app.use((_req, res) => {
  res.status(404).json({
    message: "Endpoint tidak ditemukan.",
  })
})

// Middleware penanganan error harus paling akhir
app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Server error:", error)

    res.status(500).json({
      message: "Terjadi kesalahan pada server.",
    })
  }
)

async function start() {
  try {
    await pool.query("SELECT 1")

    app.listen(port, () => {
      console.log(`API berjalan di http://localhost:${port}`)
    })
  } catch (error) {
    console.error("Koneksi database gagal:", error)
    process.exit(1)
  }
}

void start()


import type { Request, Response } from "express"
import { pool } from "../config/db.js"
import type { RowDataPacket, ResultSetHeader } from "mysql2"

interface BudgetRow extends RowDataPacket {
  id: number
  month: string
  category: string
  limit_amount: number
  spent_amount: number
}

interface BudgetInput {
  month?: string
  category?: string
  limit_amount?: number
}

function isValidMonth(month: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return false
  }

  const [year, monthNumber] = month.split("-").map(Number)

  return year >= 1000 && year <= 9999 && monthNumber >= 1 && monthNumber <= 12
}

function parseBudgetInput(body: BudgetInput) {
  const month = typeof body.month === "string" ? body.month.trim() : ""
  const category =
    typeof body.category === "string" ? body.category.trim() : ""
  const limitAmount = Number(body.limit_amount)

  if (!isValidMonth(month)) {
    return {
      error: "Format bulan tidak valid. Gunakan format YYYY-MM.",
    }
  }

  if (!category) {
    return { error: "Kategori pengeluaran wajib diisi." }
  }

  if (category.length > 100) {
    return { error: "Kategori maksimal 100 karakter." }
  }

  if (
    body.limit_amount === undefined ||
    body.limit_amount === null ||
    body.limit_amount === 0 ||
    !Number.isSafeInteger(limitAmount) ||
    limitAmount <= 0
  ) {
    return {
      error: "Batas anggaran harus berupa angka bulat lebih dari 0.",
    }
  }

  return {
    data: {
      month,
      category,
      limit_amount: limitAmount,
    },
  }
}

/**
 * GET /api/budgets?month=YYYY-MM
 * Mengambil anggaran dan total pengeluaran setiap kategori.
 */
export async function getBudgets(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const month = req.query.month

    if (typeof month !== "string" || !isValidMonth(month)) {
      res.status(400).json({
        message: "Parameter month wajib diisi dengan format YYYY-MM.",
      })
      return
    }

    const [rows] = await pool.execute<BudgetRow[]>(
      `SELECT
          b.id,
          b.month,
          b.category,
          b.limit_amount,
          COALESCE(t.spent_amount, 0) AS spent_amount
       FROM monthly_budgets b
       LEFT JOIN (
          SELECT
            category,
            DATE_FORMAT(date, '%Y-%m') AS month,
            SUM(amount) AS spent_amount
          FROM transactions
          WHERE type = 'expense'
          GROUP BY category, DATE_FORMAT(date, '%Y-%m')
       ) t
         ON t.category = b.category
        AND t.month = b.month
       WHERE b.month = ?
       ORDER BY b.category ASC`,
      [month]
    )

    res.status(200).json(
      rows.map((row) => ({
        ...row,
        id: Number(row.id),
        limit_amount: Number(row.limit_amount),
        spent_amount: Number(row.spent_amount),
      }))
    )
  } catch (error) {
    console.error("Gagal mengambil anggaran:", error)

    res.status(500).json({
      message: "Terjadi kesalahan saat mengambil data anggaran.",
    })
  }
}

/**
 * POST /api/budgets
 * Membuat anggaran atau memperbarui batasnya
 * jika kategori dan bulan sudah terdaftar.
 */
export async function createBudget(
  req: Request<unknown, unknown, BudgetInput>,
  res: Response
): Promise<void> {
  try {
    const result = parseBudgetInput(req.body)

    if ("error" in result) {
      res.status(400).json({ message: result.error })
      return
    }

    const { month, category, limit_amount } = result.data

    await pool.execute<ResultSetHeader>(
      `INSERT INTO monthly_budgets
        (month, category, limit_amount)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
        limit_amount = VALUES(limit_amount)`,
      [month, category, limit_amount]
    )

    const [rows] = await pool.execute<BudgetRow[]>(
      `SELECT
          b.id,
          b.month,
          b.category,
          b.limit_amount,
          COALESCE((
            SELECT SUM(t.amount)
            FROM transactions t
            WHERE t.type = 'expense'
              AND t.category = b.category
              AND DATE_FORMAT(t.date, '%Y-%m') = b.month
          ), 0) AS spent_amount
       FROM monthly_budgets b
       WHERE b.month = ?
         AND b.category = ?
       LIMIT 1`,
      [month, category]
    )

    if (rows.length === 0) {
      res.status(500).json({
        message: "Anggaran tersimpan, tetapi data tidak berhasil dibaca kembali.",
      })
      return
    }

    const budget = rows[0]

    res.status(200).json({
      ...budget,
      id: Number(budget.id),
      limit_amount: Number(budget.limit_amount),
      spent_amount: Number(budget.spent_amount),
    })
  } catch (error) {
    console.error("Gagal menyimpan anggaran:", error)

    res.status(500).json({
      message: "Terjadi kesalahan saat menyimpan anggaran.",
    })
  }
}

/**
 * DELETE /api/budgets/:id
 * Menghapus anggaran berdasarkan ID.
 */
export async function deleteBudget(
  req: Request<{ id: string }>,
  res: Response
): Promise<void> {
  try {
    const id = Number(req.params.id)

    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({
        message: "ID anggaran tidak valid.",
      })
      return
    }

    const [result] = await pool.execute<ResultSetHeader>(
      "DELETE FROM monthly_budgets WHERE id = ?",
      [id]
    )

    if (result.affectedRows === 0) {
      res.status(404).json({
        message: "Anggaran tidak ditemukan.",
      })
      return
    }

    res.status(200).json({
      message: "Anggaran berhasil dihapus.",
    })
  } catch (error) {
    console.error("Gagal menghapus anggaran:", error)

    res.status(500).json({
      message: "Terjadi kesalahan saat menghapus anggaran.",
    })
  }
}

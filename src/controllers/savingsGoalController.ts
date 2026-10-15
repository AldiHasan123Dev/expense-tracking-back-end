
import type { Request, Response } from "express"
import type {
  ResultSetHeader,
  RowDataPacket,
} from "mysql2"
import { pool } from "../config/db.js"

interface GoalRow extends RowDataPacket {
  id: number
  name: string
  target_amount: number
  target_date: string | null
  description: string | null
  saved_amount: number
}

interface MovementRow extends RowDataPacket {
  id: number
  goal_id: number
  type: "deposit" | "withdrawal"
  amount: number
  note: string | null
  movement_date: string
}

function validAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  )
}

function validDate(value: unknown): boolean {
  if (typeof value !== "string") return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false

  const date = new Date(`${value}T00:00:00Z`)

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  )
}

function validOptionalDate(value: unknown): boolean {
  return value === null || value === "" || validDate(value)
}

function validGoalPayload(body: Record<string, unknown>) {
  const name = typeof body.name === "string"
    ? body.name.trim()
    : ""

  const description =
    typeof body.description === "string"
      ? body.description.trim()
      : ""

  return {
    valid:
      name.length > 0 &&
      name.length <= 150 &&
      validAmount(body.target_amount) &&
      validOptionalDate(body.target_date) &&
      description.length <= 500,
    name,
    targetAmount: body.target_amount,
    targetDate: body.target_date || null,
    description: description || null,
  }
}

const goalSelect = `
  SELECT
    g.id,
    g.name,
    g.target_amount,
    DATE_FORMAT(g.target_date, '%Y-%m-%d') AS target_date,
    g.description,
    COALESCE(
      SUM(
        CASE
          WHEN m.type = 'deposit' THEN m.amount
          ELSE -m.amount
        END
      ), 0
    ) AS saved_amount
  FROM savings_goals g
  LEFT JOIN savings_movements m ON m.goal_id = g.id
`

function normalizeGoal(row: GoalRow) {
  const target = Number(row.target_amount)
  const saved = Number(row.saved_amount)

  return {
    ...row,
    target_amount: target,
    saved_amount: saved,
    remaining_amount: Math.max(target - saved, 0),
    progress: target > 0
      ? Math.round((saved / target) * 10000) / 100
      : 0,
    is_completed: saved >= target,
  }
}

export async function getGoals(
  _req: Request,
  res: Response
): Promise<void> {
  try {
    const [rows] = await pool.query<GoalRow[]>(`
      ${goalSelect}
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `)

    res.json(rows.map(normalizeGoal))
  } catch (error) {
    console.error("Gagal mengambil target tabungan:", error)
    res.status(500).json({
      message: "Gagal mengambil target tabungan.",
    })
  }
}

export async function createGoal(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const input = validGoalPayload(req.body)

    if (!input.valid) {
      res.status(400).json({
        message: "Periksa nama, nominal, tanggal, dan deskripsi target.",
      })
      return
    }

    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO savings_goals
        (name, target_amount, target_date, description)
       VALUES (?, ?, ?, ?)`,
      [
        input.name,
        input.targetAmount,
        input.targetDate,
        input.description,
      ]
    )

    res.status(201).json({
      id: result.insertId,
      name: input.name,
      target_amount: input.targetAmount,
      target_date: input.targetDate,
      description: input.description,
      saved_amount: 0,
      remaining_amount: input.targetAmount,
      progress: 0,
      is_completed: false,
    })
  } catch (error) {
    console.error("Gagal membuat target:", error)
    res.status(500).json({
      message: "Gagal membuat target tabungan.",
    })
  }
}

export async function updateGoal(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const id = Number(req.params.id)

    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ message: "ID target tidak valid." })
      return
    }

    const input = validGoalPayload(req.body)

    if (!input.valid) {
      res.status(400).json({
        message: "Periksa nama, nominal, tanggal, dan deskripsi target.",
      })
      return
    }

    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE savings_goals
       SET name = ?, target_amount = ?, target_date = ?, description = ?
       WHERE id = ?`,
      [
        input.name,
        input.targetAmount,
        input.targetDate,
        input.description,
        id,
      ]
    )

    if (result.affectedRows === 0) {
      res.status(404).json({ message: "Target tidak ditemukan." })
      return
    }

    res.json({ message: "Target berhasil diperbarui." })
  } catch (error) {
    console.error("Gagal memperbarui target:", error)
    res.status(500).json({
      message: "Gagal memperbarui target tabungan.",
    })
  }
}

export async function deleteGoal(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const id = Number(req.params.id)

    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ message: "ID target tidak valid." })
      return
    }

    const [result] = await pool.query<ResultSetHeader>(
      "DELETE FROM savings_goals WHERE id = ?",
      [id]
    )

    if (result.affectedRows === 0) {
      res.status(404).json({ message: "Target tidak ditemukan." })
      return
    }

    res.json({ message: "Target dan riwayatnya berhasil dihapus." })
  } catch (error) {
    console.error("Gagal menghapus target:", error)
    res.status(500).json({
      message: "Gagal menghapus target tabungan.",
    })
  }
}

export async function getMovements(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const goalId = Number(req.params.id)

    if (!Number.isSafeInteger(goalId) || goalId <= 0) {
      res.status(400).json({ message: "ID target tidak valid." })
      return
    }

    const [goals] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM savings_goals WHERE id = ?",
      [goalId]
    )

    if (goals.length === 0) {
      res.status(404).json({ message: "Target tidak ditemukan." })
      return
    }

    const [rows] = await pool.query<MovementRow[]>(
      `SELECT id, goal_id, type, amount, note,
              DATE_FORMAT(movement_date, '%Y-%m-%d') AS movement_date
       FROM savings_movements
       WHERE goal_id = ?
       ORDER BY movement_date DESC, id DESC`,
      [goalId]
    )

    res.json(rows.map((row) => ({
      ...row,
      amount: Number(row.amount),
    })))
  } catch (error) {
    console.error("Gagal mengambil riwayat tabungan:", error)
    res.status(500).json({
      message: "Gagal mengambil riwayat tabungan.",
    })
  }
}

export async function createMovement(
  req: Request,
  res: Response
): Promise<void> {
  const connection = await pool.getConnection()

  try {
    const goalId = Number(req.params.id)
    const { type, amount, note, movement_date } = req.body as {
      type?: unknown
      amount?: unknown
      note?: unknown
      movement_date?: unknown
    }

    if (
      !Number.isSafeInteger(goalId) ||
      goalId <= 0 ||
      (type !== "deposit" && type !== "withdrawal") ||
      !validAmount(amount) ||
      (note !== undefined &&
        note !== null &&
        (typeof note !== "string" || note.trim().length > 255)) ||
      (movement_date !== undefined && !validDate(movement_date))
    ) {
      res.status(400).json({
        message: "Data setoran atau penarikan tidak valid.",
      })
      return
    }

    await connection.beginTransaction()

    const [goals] = await connection.query<RowDataPacket[]>(
      "SELECT id FROM savings_goals WHERE id = ? FOR UPDATE",
      [goalId]
    )

    if (goals.length === 0) {
      await connection.rollback()
      res.status(404).json({ message: "Target tidak ditemukan." })
      return
    }

    if (type === "withdrawal") {
      const [balanceRows] = await connection.query<RowDataPacket[]>(
        `SELECT COALESCE(
          SUM(CASE
            WHEN type = 'deposit' THEN amount
            ELSE -amount
          END), 0
        ) AS balance
        FROM savings_movements
        WHERE goal_id = ?`,
        [goalId]
      )

      const balance = Number(balanceRows[0].balance)

      if (amount > balance) {
        await connection.rollback()
        res.status(400).json({
          message: "Penarikan melebihi saldo tabungan yang tersedia.",
        })
        return
      }
    }

    const [result] = await connection.query<ResultSetHeader>(
      `INSERT INTO savings_movements
        (goal_id, type, amount, note, movement_date)
       VALUES (?, ?, ?, ?, ?)`,
      [
        goalId,
        type,
        amount,
        typeof note === "string" ? note.trim() || null : null,
        movement_date ?? new Date().toISOString().slice(0, 10),
      ]
    )

    await connection.commit()

    res.status(201).json({
      id: result.insertId,
      goal_id: goalId,
      type,
      amount,
      note: typeof note === "string" ? note.trim() || null : null,
      movement_date:
        movement_date ?? new Date().toISOString().slice(0, 10),
    })
  } catch (error) {
    await connection.rollback()
    console.error("Gagal mencatat tabungan:", error)
    res.status(500).json({
      message: "Gagal mencatat setoran atau penarikan.",
    })
  } finally {
    connection.release()
  }
}

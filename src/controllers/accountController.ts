// src/controllers/accountController.ts

import type { Request, Response } from "express"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { pool } from "../config/db.js"

type AccountType = "cash" | "ewallet" | "bank"

interface AccountRow extends RowDataPacket {
  id: number
  name: string
  type: AccountType
  balance: number | string
}

const validTypes: AccountType[] = ["cash", "ewallet", "bank"]

// SQL untuk menghitung saldo terkini setiap rekening.

const accountBalanceSql = `
  SELECT
    a.id,
    a.name,
    a.type,
    COALESCE(t.income_total, 0)
      - COALESCE(t.expense_total, 0)
      - COALESCE(tr.sent_total, 0)
      + COALESCE(tr.received_total, 0) AS balance
  FROM accounts a
  LEFT JOIN (
    SELECT
      account_id,
      SUM(
        CASE
          WHEN type = 'income' THEN amount
          ELSE 0
        END
      ) AS income_total,
      SUM(
        CASE
          WHEN type = 'expense' THEN amount
          ELSE 0
        END
      ) AS expense_total
    FROM transactions
    WHERE account_id IS NOT NULL
      AND (category IS NULL OR category <> 'Transfer')
    GROUP BY account_id
  ) t ON t.account_id = a.id
  LEFT JOIN (
    SELECT
      account_id,
      SUM(sent_total) AS sent_total,
      SUM(received_total) AS received_total
    FROM (
      SELECT
        from_account_id AS account_id,
        SUM(amount) AS sent_total,
        0 AS received_total
      FROM account_transfers
      GROUP BY from_account_id

      UNION ALL

      SELECT
        to_account_id AS account_id,
        0 AS sent_total,
        SUM(amount) AS received_total
      FROM account_transfers
      GROUP BY to_account_id
    ) transfer_rows
    GROUP BY account_id
  ) tr ON tr.account_id = a.id
`


// GET /api/accounts
// Daftar rekening beserta saldo terkini.
export async function index(_req: Request, res: Response) {
  try {
    const [accounts] = await pool.query<AccountRow[]>(`
      ${accountBalanceSql}
      ORDER BY a.created_at DESC
    `)

    res.json(accounts)
  } catch (error) {
    console.error("Gagal mengambil rekening:", error)
    res.status(500).json({
      message: "Gagal mengambil daftar rekening.",
    })
  }
}

// POST /api/accounts
// Tambah rekening. Saldo otomatis dimulai dari nol.
export async function store(req: Request, res: Response) {
  const name =
    typeof req.body.name === "string" ? req.body.name.trim() : ""
  const type = req.body.type as AccountType

  if (!name || !validTypes.includes(type)) {
    res.status(400).json({
      message: "Nama dan jenis rekening wajib diisi dengan benar.",
    })
    return
  }

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      "INSERT INTO accounts (name, type) VALUES (?, ?)",
      [name, type],
    )

    res.status(201).json({
      id: result.insertId,
      name,
      type,
      balance: 0,
    })
  } catch (error) {
    console.error("Gagal menambah rekening:", error)
    res.status(500).json({
      message: "Gagal menambah rekening.",
    })
  }
}

// PUT /api/accounts/:id
// Ubah nama dan jenis rekening tanpa mengubah saldo.
export async function update(req: Request, res: Response) {
  const id = Number(req.params.id)
  const name =
    typeof req.body.name === "string" ? req.body.name.trim() : ""
  const type = req.body.type as AccountType

  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !name ||
    !validTypes.includes(type)
  ) {
    res.status(400).json({
      message: "Data rekening tidak valid.",
    })
    return
  }

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      "UPDATE accounts SET name = ?, type = ? WHERE id = ?",
      [name, type, id],
    )

    if (result.affectedRows === 0) {
      res.status(404).json({
        message: "Rekening tidak ditemukan.",
      })
      return
    }

    res.json({ id, name, type })
  } catch (error) {
    console.error("Gagal mengubah rekening:", error)
    res.status(500).json({
      message: "Gagal mengubah rekening.",
    })
  }
}

// DELETE /api/accounts/:id
// Hapus rekening hanya jika tidak memiliki transaksi atau transfer.
export async function destroy(req: Request, res: Response) {
  const id = Number(req.params.id)

  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({
      message: "ID rekening tidak valid.",
    })
    return
  }

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      "DELETE FROM accounts WHERE id = ?",
      [id],
    )

    if (result.affectedRows === 0) {
      res.status(404).json({
        message: "Rekening tidak ditemukan.",
      })
      return
    }

    res.json({
      message: "Rekening berhasil dihapus.",
    })
  } catch (error) {
    console.error("Gagal menghapus rekening:", error)
    res.status(409).json({
      message:
        "Rekening tidak dapat dihapus karena masih digunakan transaksi atau transfer.",
    })
  }
}

// POST /api/accounts/transfers
// Transfer saldo antar-rekening.
export async function transfer(req: Request, res: Response) {
  const fromId = Number(req.body.from_account_id)
  const toId = Number(req.body.to_account_id)
  const amount = Number(req.body.amount)

  const note =
    typeof req.body.note === "string"
      ? req.body.note.trim()
      : null

  const transferDate =
    typeof req.body.transfer_date === "string"
      ? req.body.transfer_date
      : new Date().toISOString().slice(0, 10)

  if (
    !Number.isSafeInteger(fromId) ||
    !Number.isSafeInteger(toId) ||
    fromId <= 0 ||
    toId <= 0 ||
    fromId === toId ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(transferDate)
  ) {
    res.status(400).json({
      message: "Data transfer tidak valid.",
    })
    return
  }

  const connection = await pool.getConnection()

  try {
    await connection.beginTransaction()

    // Kunci rekening agar proses transfer dapat divalidasi.
    const [accounts] = await connection.query<AccountRow[]>(
      `
        ${accountBalanceSql}
        WHERE a.id IN (?, ?)
        FOR UPDATE
      `,
      [fromId, toId],
    )

    const source = accounts.find((account) => account.id === fromId)
    const destination = accounts.find((account) => account.id === toId)

    if (!source || !destination) {
      await connection.rollback()

      res.status(404).json({
        message: "Rekening asal atau tujuan tidak ditemukan.",
      })
      return
    }

    if (Number(source.balance) < amount) {
      await connection.rollback()

      res.status(400).json({
        message: "Saldo rekening asal tidak mencukupi.",
      })
      return
    }

    // 1. Simpan data transfer utama.
    const [transferResult] =
      await connection.execute<ResultSetHeader>(
        `
          INSERT INTO account_transfers
            (
              from_account_id,
              to_account_id,
              amount,
              note,
              transfer_date
            )
          VALUES (?, ?, ?, ?, ?)
        `,
        [fromId, toId, amount, note || null, transferDate],
      )

    // 2. Catat pengeluaran dari rekening asal.
    await connection.execute<ResultSetHeader>(
      `
        INSERT INTO transactions
          (account_id, title, amount, type, category, date)
        VALUES (?, ?, ?, 'expense', 'Transfer', ?)
      `,
      [
        fromId,
        `Transfer ke ${destination.name}`,
        amount,
        transferDate,
      ],
    )

    // 3. Catat pemasukan ke rekening tujuan.
    await connection.execute<ResultSetHeader>(
      `
        INSERT INTO transactions
          (account_id, title, amount, type, category, date)
        VALUES (?, ?, ?, 'income', 'Transfer', ?)
      `,
      [
        toId,
        `Transfer dari ${source.name}`,
        amount,
        transferDate,
      ],
    )

    // Ketiga penyimpanan berhasil, baru commit.
    await connection.commit()

    res.status(201).json({
      id: transferResult.insertId,
      from_account_id: fromId,
      to_account_id: toId,
      amount,
      note,
      transfer_date: transferDate,
      message: "Transfer berhasil dan tercatat di transaksi.",
    })
  } catch (error) {
    await connection.rollback()

    console.error("Gagal melakukan transfer:", error)

    res.status(500).json({
      message: "Gagal melakukan transfer.",
    })
  } finally {
    connection.release()
  }
}


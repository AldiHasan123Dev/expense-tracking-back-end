import type { Request, Response } from "express"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import { pool } from "../config/db.js"

type AccountType = "cash" | "ewallet" | "bank"

interface AccountRow extends RowDataPacket {
  id: number
  name: string
  type: AccountType
  initial_balance: number | string
  balance: number | string
}

interface CountRow extends RowDataPacket {
  transaction_count: number | string
  transfer_count: number | string
}

const validTypes: AccountType[] = ["cash", "ewallet", "bank"]

/**
 * Saldo = saldo awal + pemasukan - pengeluaran
 *         - transfer keluar + transfer masuk.
 *
 * Baris transaksi kategori Transfer tidak dijumlahkan lagi,
 * karena transfer sudah dihitung melalui account_transfers.
 */
const accountBalanceSql = `
  SELECT
    a.id,
    a.name,
    a.type,
    a.initial_balance,
    COALESCE(t.income_total, 0)
      - COALESCE(t.expense_total, 0)
      - COALESCE(tr.sent_total, 0)
      + COALESCE(tr.received_total, 0) AS balance
  FROM accounts a
  LEFT JOIN (
    SELECT
      account_id,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) AS income_total,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) AS expense_total
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

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false

  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function getLocalDate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function isValidId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function getRequestBody(req: Request): Record<string, unknown> {
  if (req.body !== null && typeof req.body === "object" && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>
  }
  return {}
}

async function safeRollback(
  connection: PoolConnection,
  transactionStarted: boolean,
): Promise<void> {
  if (!transactionStarted) return

  try {
    await connection.rollback()
  } catch (error) {
    console.error("Gagal melakukan rollback:", error)
  }
}

// GET /api/accounts
export async function index(_req: Request, res: Response): Promise<void> {
  try {
    const [accounts] = await pool.query<AccountRow[]>(`
      ${accountBalanceSql}
      ORDER BY a.created_at DESC, a.id DESC
    `)

    res.json(
      accounts.map((account) => ({
        ...account,
        initial_balance: Number(account.initial_balance),
        balance: Number(account.balance),
      })),
    )
  } catch (error) {
    console.error("Gagal mengambil rekening:", error)
    res.status(500).json({ message: "Gagal mengambil daftar rekening." })
  }
}

// POST /api/accounts

export async function store(req: Request, res: Response): Promise<void> {
  const body = getRequestBody(req)
  const name = typeof body.name === "string" ? body.name.trim() : ""
  const type = body.type

  if (
    !name ||
    typeof type !== "string" ||
    !validTypes.includes(type as AccountType)
  ) {
    res.status(400).json({
      message: "Nama dan jenis rekening wajib diisi dengan benar.",
    })
    return
  }

  try {
    const [result] = await pool.execute<ResultSetHeader>(
      "INSERT INTO accounts (name, type, initial_balance) VALUES (?, ?, 0)",
      [name, type as AccountType],
    )

    res.status(201).json({
      id: result.insertId,
      name,
      type: type as AccountType,
      initial_balance: 0,
      balance: 0,
    })
  } catch (error) {
    console.error("Gagal membuat rekening:", error)

    res.status(500).json({
      message: "Gagal membuat rekening.",
    })
  }
}


// PUT /api/accounts/:id
export async function update(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id)
  const body = getRequestBody(req)
  const name = typeof body.name === "string" ? body.name.trim() : ""
  const type = body.type

if (
  !isValidId(id) ||
  !name ||
  typeof type !== "string" ||
  !validTypes.includes(type as AccountType)
) {
  res.status(400).json({ message: "Data rekening tidak valid." })
  return
}

  let connection: PoolConnection | undefined
  let transactionStarted = false

  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    transactionStarted = true

    const [accounts] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM accounts WHERE id = ? FOR UPDATE`,
      [id],
    )

    if (accounts.length === 0) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false
      res.status(404).json({ message: "Rekening tidak ditemukan." })
      return
    }

    await connection.execute<ResultSetHeader>(
      `UPDATE accounts SET name = ?, type = ? WHERE id = ?`,
      [name, type, id],
    )

    await connection.commit()
    transactionStarted = false

    res.json({
      id,
      name,
      type,
      message: "Rekening berhasil diperbarui.",
    })
  } catch (error) {
    if (connection) await safeRollback(connection, transactionStarted)
    console.error("Gagal mengubah rekening:", error)
    res.status(500).json({ message: "Gagal mengubah rekening." })
  } finally {
    connection?.release()
  }
}

// DELETE /api/accounts/:id
export async function destroy(req: Request, res: Response): Promise<void> {
  const id = Number(req.params.id)

  if (!isValidId(id)) {
    res.status(400).json({ message: "ID rekening tidak valid." })
    return
  }

  let connection: PoolConnection | undefined
  let transactionStarted = false

  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    transactionStarted = true

    const [accounts] = await connection.query<RowDataPacket[]>(
      `SELECT id FROM accounts WHERE id = ? FOR UPDATE`,
      [id],
    )

    if (accounts.length === 0) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false
      res.status(404).json({ message: "Rekening tidak ditemukan." })
      return
    }

    const [references] = await connection.query<CountRow[]>(
      `
        SELECT
          (SELECT COUNT(*) FROM transactions WHERE account_id = ?) AS transaction_count,
          (
            SELECT COUNT(*)
            FROM account_transfers
            WHERE from_account_id = ? OR to_account_id = ?
          ) AS transfer_count
      `,
      [id, id, id],
    )

    const transactionCount = Number(references[0]?.transaction_count ?? 0)
    const transferCount = Number(references[0]?.transfer_count ?? 0)

    if (transactionCount > 0 || transferCount > 0) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false
      res.status(409).json({
        message:
          "Rekening tidak dapat dihapus karena masih memiliki transaksi atau riwayat transfer.",
        transaction_count: transactionCount,
        transfer_count: transferCount,
      })
      return
    }

    await connection.execute<ResultSetHeader>(
      `DELETE FROM accounts WHERE id = ?`,
      [id],
    )

    await connection.commit()
    transactionStarted = false
    res.json({ message: "Rekening berhasil dihapus." })
  } catch (error) {
    if (connection) await safeRollback(connection, transactionStarted)
    console.error("Gagal menghapus rekening:", error)
    res.status(409).json({
      message:
        "Rekening tidak dapat dihapus. Periksa relasi atau penggunaan rekening pada data lain.",
    })
  } finally {
    connection?.release()
  }
}

// POST /api/accounts/transfers
export async function transfer(req: Request, res: Response): Promise<void> {
  const body = getRequestBody(req)
  const fromId = Number(body.from_account_id)
  const toId = Number(body.to_account_id)
  const amount = Number(body.amount)

  const note =
    typeof body.note === "string" ? body.note.trim() || null : null

  const transferDate =
    typeof body.transfer_date === "string"
      ? body.transfer_date
      : getLocalDate()

  if (
    !isValidId(fromId) ||
    !isValidId(toId) ||
    fromId === toId ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !isValidDate(transferDate)
  ) {
    res.status(400).json({ message: "Data transfer tidak valid." })
    return
  }

  let connection: PoolConnection | undefined
  let transactionStarted = false

  try {
    connection = await pool.getConnection()
    await connection.beginTransaction()
    transactionStarted = true

    // Kunci kedua rekening berdasarkan urutan ID untuk mengurangi deadlock.
   const [lockedAccounts] = await connection.execute<RowDataPacket[]>(
  `SELECT id
   FROM accounts
   WHERE id IN (?, ?)
   ORDER BY id ASC
   FOR UPDATE`,
  [fromId, toId],
)

    if (lockedAccounts.length !== 2) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false
      res.status(404).json({
        message: "Rekening asal atau tujuan tidak ditemukan.",
      })
      return
    }

const [accounts] = await connection.execute<AccountRow[]>(
  `${accountBalanceSql} WHERE a.id IN (?, ?)`,
  [fromId, toId],
)

    const source = accounts.find((account) => Number(account.id) === fromId)
    const destination = accounts.find((account) => Number(account.id) === toId)

    if (!source || !destination) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false
      res.status(404).json({
        message: "Rekening asal atau tujuan tidak ditemukan.",
      })
      return
    }

    const sourceBalance = Number(source.balance)

    if (!Number.isFinite(sourceBalance)) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false
      res.status(500).json({
        message: "Saldo rekening asal tidak dapat dihitung.",
      })
      return
    }

    if (sourceBalance < amount) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false
      res.status(422).json({
        message: "Saldo rekening asal tidak mencukupi.",
        available_balance: sourceBalance,
        requested_amount: amount,
      })
      return
    }

    const [transferResult] = await connection.execute<ResultSetHeader>(
      `
        INSERT INTO account_transfers (
          from_account_id,
          to_account_id,
          amount,
          note,
          transfer_date
        )
        VALUES (?, ?, ?, ?, ?)
      `,
      [fromId, toId, amount, note, transferDate],
    )

    // Catat pengeluaran dari rekening asal.
    await connection.execute<ResultSetHeader>(
      `
        INSERT INTO transactions (
          account_id, title, amount, type, category, date
        )
        VALUES (?, ?, ?, 'expense', 'Transfer', ?)
      `,
      [fromId, `Transfer ke ${destination.name}`, amount, transferDate],
    )

    // Catat pemasukan ke rekening tujuan.
    await connection.execute<ResultSetHeader>(
      `
        INSERT INTO transactions (
          account_id, title, amount, type, category, date
        )
        VALUES (?, ?, ?, 'income', 'Transfer', ?)
      `,
      [toId, `Transfer dari ${source.name}`, amount, transferDate],
    )

    await connection.commit()
    transactionStarted = false

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
    if (connection) await safeRollback(connection, transactionStarted)
    console.error("Gagal melakukan transfer:", error)
    res.status(500).json({
      message:
        "Gagal melakukan transfer. Operasi dibatalkan jika transaksi database belum berhasil di-commit.",
    })
  } finally {
    connection?.release()
  }
}
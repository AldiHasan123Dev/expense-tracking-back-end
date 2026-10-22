
import type { Request, Response, NextFunction } from "express"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import type { PoolConnection } from "mysql2/promise"
import { pool } from "../config/db.js"

type TransactionType = "income" | "expense"

interface TransactionRow extends RowDataPacket {
  id: number
  account_id: number
  title: string
  amount: number | string
  type: TransactionType
  category: string
  date: string
}

interface AccountRow extends RowDataPacket {
  id: number
}

interface AccountBalanceRow extends RowDataPacket {
  id: number
  name: string
  type: "cash" | "ewallet" | "bank"
  initial_balance: number | string
  balance: number | string
}

interface TransactionInput {
  account_id: number
  title: string
  amount: number
  type: TransactionType
  category: string
  date: string
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function validBody(body: unknown): body is Record<string, unknown> {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    return false
  }

  const data = body as Record<string, unknown>

  if (
    typeof data.title !== "string" ||
    data.title.trim().length === 0 ||
    data.title.trim().length > 150
  ) {
    return false
  }

  if (
    typeof data.amount !== "number" ||
    !Number.isSafeInteger(data.amount) ||
    data.amount <= 0
  ) {
    return false
  }

  if (data.type !== "income" && data.type !== "expense") {
    return false
  }

  if (
    typeof data.category !== "string" ||
    data.category.trim().length === 0 ||
    data.category.trim().length > 100
  ) {
    return false
  }

  // Kategori Transfer hanya boleh dibuat oleh fitur transfer rekening.
  if (data.category.trim().toLowerCase() === "transfer") {
    return false
  }

  if (
    typeof data.account_id !== "number" ||
    !Number.isSafeInteger(data.account_id) ||
    data.account_id <= 0
  ) {
    return false
  }

  if (
    typeof data.date !== "string" ||
    !isValidDate(data.date)
  ) {
    return false
  }

  return true
}

function validId(value: string | string[]): number | null {
  const idValue = Array.isArray(value) ? value[0] : value

  if (!idValue || !/^[1-9]\d*$/.test(idValue)) {
    return null
  }

  const id = Number(idValue)

  return Number.isSafeInteger(id) ? id : null
}

function transactionDelta(
  type: TransactionType,
  amount: number,
): number {
  return type === "income" ? amount : -amount
}

function readInput(
  body: Record<string, unknown>,
): TransactionInput {
  return {
    account_id: body.account_id as number,
    title: (body.title as string).trim(),
    amount: body.amount as number,
    type: body.type as TransactionType,
    category: (body.category as string).trim(),
    date: body.date as string,
  }
}

const selectSql = `
  SELECT
    t.id,
    t.account_id,
    a.name AS account_name,
    t.title,
    t.amount,
    t.type,
    t.category,
    DATE_FORMAT(t.date, '%Y-%m-%d') AS date
  FROM transactions t
  LEFT JOIN accounts a ON a.id = t.account_id
`

/**
 * Saldo dihitung dari saldo awal dan catatan transaksi.
 *
 * Catatan berkategori Transfer dikecualikan dari agregasi
 * transactions karena transfer dihitung melalui account_transfers.
 *
 * Jangan mengubah initial_balance saat mencatat transaksi biasa.
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

function serializeTransaction(row: TransactionRow) {
  return {
    ...row,
    id: Number(row.id),
    account_id: Number(row.account_id),
    amount: Number(row.amount),
  }
}

/**
 * Kunci rekening berdasarkan urutan ID untuk mengurangi risiko
 * deadlock dan memastikan transaksi menggunakan saldo terkini.
 *
 * Semua operasi yang mengubah transaksi keuangan sebaiknya
 * menggunakan urutan penguncian yang sama.
 */
async function lockAccounts(
  connection: PoolConnection,
  accountIds: number[],
): Promise<void> {
  const uniqueIds = [...new Set(accountIds)].sort((a, b) => a - b)

  if (uniqueIds.length === 0) {
    return
  }

  const placeholders = uniqueIds.map(() => "?").join(", ")

  const [rows] = await connection.execute<AccountRow[]>(
    `
      SELECT id
      FROM accounts
      WHERE id IN (${placeholders})
      ORDER BY id ASC
      FOR UPDATE
    `,
    uniqueIds,
  )

  if (rows.length !== uniqueIds.length) {
    throw new Error("ACCOUNT_NOT_FOUND")
  }
}

/**
 * Mengambil saldo terkini dari sumber data yang sama dengan
 * endpoint GET /api/accounts.
 *
 * Fungsi ini tidak mengubah initial_balance.
 */
async function getAccountBalances(
  connection: PoolConnection,
  accountIds: number[],
): Promise<Map<number, number>> {
  const uniqueIds = [...new Set(accountIds)]

  const balances = new Map<number, number>()

  if (uniqueIds.length === 0) {
    return balances
  }

  const placeholders = uniqueIds.map(() => "?").join(", ")

  const [rows] = await connection.execute<AccountBalanceRow[]>(
    `
      ${accountBalanceSql}
      WHERE a.id IN (${placeholders})
    `,
    uniqueIds,
  )

  for (const row of rows) {
    const balance = Number(row.balance)

    if (!Number.isFinite(balance)) {
      throw new Error("INVALID_ACCOUNT_BALANCE")
    }

    balances.set(Number(row.id), balance)
  }

  if (balances.size !== uniqueIds.length) {
    throw new Error("ACCOUNT_NOT_FOUND")
  }

  return balances
}

/**
 * Membaca transaksi yang sudah terkunci.
 * Panggil setelah rekening terkait dikunci.
 */
async function getLockedTransaction(
  connection: PoolConnection,
  id: number,
): Promise<TransactionRow | null> {
  const [rows] = await connection.execute<TransactionRow[]>(
    `${selectSql} WHERE id = ? FOR UPDATE`,
    [id],
  )

  return rows[0] ?? null
}

async function safeRollback(
  connection: PoolConnection,
  transactionStarted: boolean,
): Promise<void> {
  if (!transactionStarted) {
    return
  }

  try {
    await connection.rollback()
  } catch (error) {
    console.error("Gagal melakukan rollback:", error)
  }
}

function sendTransactionError(
  error: unknown,
  res: Response,
  next: NextFunction,
): void {
  if (error instanceof Error) {
    if (error.message === "ACCOUNT_NOT_FOUND") {
      res.status(404).json({
        message: "Rekening tidak ditemukan.",
      })
      return
    }

    if (error.message === "INSUFFICIENT_BALANCE") {
      res.status(422).json({
        message:
          "Saldo rekening tidak mencukupi untuk transaksi ini.",
      })
      return
    }

    if (error.message === "TRANSFER_TRANSACTION_LOCKED") {
      res.status(409).json({
        message:
          "Transaksi transfer tidak dapat diubah atau dihapus melalui menu transaksi. Gunakan fitur transfer rekening.",
      })
      return
    }

    if (error.message === "TRANSACTION_CHANGED") {
      res.status(409).json({
        message:
          "Transaksi berubah oleh proses lain. Muat ulang data lalu coba kembali.",
      })
      return
    }

    if (error.message === "INVALID_ACCOUNT_BALANCE") {
      res.status(500).json({
        message: "Saldo rekening tidak dapat dihitung.",
      })
      return
    }
  }

  next(error)
}

// =====================================================
// GET /api/transactions
// =====================================================
export async function index(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const [rows] = await pool.execute<TransactionRow[]>(
      `${selectSql} ORDER BY date DESC, id DESC`,
    )

    res.json(rows.map(serializeTransaction))
  } catch (error) {
    next(error)
  }
}

// =====================================================
// GET /api/transactions/:id
// =====================================================
export async function show(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = validId(req.params.id)

    if (id === null) {
      res.status(400).json({
        message: "ID tidak valid.",
      })
      return
    }

    const [rows] = await pool.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [id],
    )

    if (rows.length === 0) {
      res.status(404).json({
        message: "Transaksi tidak ditemukan.",
      })
      return
    }

    res.json(serializeTransaction(rows[0]))
  } catch (error) {
    next(error)
  }
}

// =====================================================
// POST /api/transactions
// =====================================================
export async function store(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!validBody(req.body)) {
    res.status(422).json({
      message:
        "Data transaksi tidak valid. Pastikan rekening, nominal, kategori, dan tanggal benar.",
    })
    return
  }

  const input = readInput(req.body)

  let connection: PoolConnection | undefined
  let transactionStarted = false

  try {
    connection = await pool.getConnection()

    await connection.beginTransaction()
    transactionStarted = true

    // Kunci rekening sebelum memeriksa saldo.
    await lockAccounts(connection, [input.account_id])

    const balances = await getAccountBalances(
      connection,
      [input.account_id],
    )

    const currentBalance = balances.get(input.account_id)!

    const delta = transactionDelta(input.type, input.amount)

    if (currentBalance + delta < 0) {
      throw new Error("INSUFFICIENT_BALANCE")
    }

    const [result] = await connection.execute<ResultSetHeader>(
      `
        INSERT INTO transactions
          (account_id, title, amount, type, category, date)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        input.account_id,
        input.title,
        input.amount,
        input.type,
        input.category,
        input.date,
      ],
    )

    const [rows] = await connection.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [result.insertId],
    )

    if (rows.length === 0) {
      throw new Error("TRANSACTION_READ_FAILED")
    }

    await connection.commit()
    transactionStarted = false

    res.status(201).json(serializeTransaction(rows[0]))
  } catch (error) {
    if (connection) {
      await safeRollback(connection, transactionStarted)
    }

    sendTransactionError(error, res, next)
  } finally {
    connection?.release()
  }
}

// =====================================================
// PUT /api/transactions/:id
// =====================================================
export async function update(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const id = validId(req.params.id)

  if (id === null) {
    res.status(400).json({
      message: "ID tidak valid.",
    })
    return
  }

  if (!validBody(req.body)) {
    res.status(422).json({
      message:
        "Data transaksi tidak valid. Pastikan rekening, nominal, kategori, dan tanggal benar.",
    })
    return
  }

  const input = readInput(req.body)

  let connection: PoolConnection | undefined
  let transactionStarted = false

  try {
    connection = await pool.getConnection()

    await connection.beginTransaction()
    transactionStarted = true

    /*
     * Baca transaksi terlebih dahulu untuk mengetahui rekening lama.
     * Baris ini belum dikunci. Setelah rekening dikunci, transaksi
     * akan dibaca ulang dengan FOR UPDATE.
     */
    const [snapshotRows] = await connection.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [id],
    )

    if (snapshotRows.length === 0) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false

      res.status(404).json({
        message: "Transaksi tidak ditemukan.",
      })
      return
    }

    const snapshot = snapshotRows[0]

    if (snapshot.category?.toLowerCase() === "transfer") {
      throw new Error("TRANSFER_TRANSACTION_LOCKED")
    }

    const snapshotAccountId = Number(snapshot.account_id)

    // Semua rekening dikunci dengan urutan ID yang konsisten.
    await lockAccounts(connection, [
      snapshotAccountId,
      input.account_id,
    ])

    const oldTransaction = await getLockedTransaction(
      connection,
      id,
    )

    if (!oldTransaction) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false

      res.status(404).json({
        message: "Transaksi tidak ditemukan.",
      })
      return
    }

    /*
     * Jika rekening berubah sejak snapshot dibaca, jangan lanjut
     * menggunakan saldo atau rekening yang sudah kedaluwarsa.
     */
    if (Number(oldTransaction.account_id) !== snapshotAccountId) {
      throw new Error("TRANSACTION_CHANGED")
    }

    if (oldTransaction.category?.toLowerCase() === "transfer") {
      throw new Error("TRANSFER_TRANSACTION_LOCKED")
    }

    const oldAccountId = Number(oldTransaction.account_id)

    const balances = await getAccountBalances(
      connection,
      [oldAccountId, input.account_id],
    )

    const oldBalance = balances.get(oldAccountId)!
    const newAccountBalance = balances.get(input.account_id)!

    const oldDelta = transactionDelta(
      oldTransaction.type,
      Number(oldTransaction.amount),
    )

    const newDelta = transactionDelta(
      input.type,
      input.amount,
    )

    /*
     * Kembalikan pengaruh transaksi lama secara matematis,
     * lalu periksa kondisi setelah transaksi baru diterapkan.
     *
     * Saldo tidak diubah langsung di accounts.initial_balance.
     */
    const restoredOldBalance = oldBalance - oldDelta

    const resultingOldBalance =
      input.account_id === oldAccountId
        ? restoredOldBalance + newDelta
        : restoredOldBalance

    const resultingNewBalance =
      input.account_id === oldAccountId
        ? resultingOldBalance
        : newAccountBalance + newDelta

    if (
      resultingOldBalance < 0 ||
      resultingNewBalance < 0
    ) {
      throw new Error("INSUFFICIENT_BALANCE")
    }

    await connection.execute<ResultSetHeader>(
      `
        UPDATE transactions
        SET
          account_id = ?,
          title = ?,
          amount = ?,
          type = ?,
          category = ?,
          date = ?
        WHERE id = ?
      `,
      [
        input.account_id,
        input.title,
        input.amount,
        input.type,
        input.category,
        input.date,
        id,
      ],
    )

    const [rows] = await connection.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [id],
    )

    if (rows.length === 0) {
      throw new Error("TRANSACTION_READ_FAILED")
    }

    await connection.commit()
    transactionStarted = false

    res.json(serializeTransaction(rows[0]))
  } catch (error) {
    if (connection) {
      await safeRollback(connection, transactionStarted)
    }

    sendTransactionError(error, res, next)
  } finally {
    connection?.release()
  }
}

// =====================================================
// DELETE /api/transactions/:id
// =====================================================
export async function destroy(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const id = validId(req.params.id)

  if (id === null) {
    res.status(400).json({
      message: "ID tidak valid.",
    })
    return
  }

  let connection: PoolConnection | undefined
  let transactionStarted = false

  try {
    connection = await pool.getConnection()

    await connection.beginTransaction()
    transactionStarted = true

    // Baca transaksi untuk mengetahui rekening yang harus dikunci.
    const [snapshotRows] = await connection.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [id],
    )

    if (snapshotRows.length === 0) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false

      res.status(404).json({
        message: "Transaksi tidak ditemukan.",
      })
      return
    }

    const snapshot = snapshotRows[0]

    if (snapshot.category?.toLowerCase() === "transfer") {
      throw new Error("TRANSFER_TRANSACTION_LOCKED")
    }

    const accountId = Number(snapshot.account_id)

    await lockAccounts(connection, [accountId])

    const transaction = await getLockedTransaction(connection, id)

    if (!transaction) {
      await safeRollback(connection, transactionStarted)
      transactionStarted = false

      res.status(404).json({
        message: "Transaksi tidak ditemukan.",
      })
      return
    }

    if (Number(transaction.account_id) !== accountId) {
      throw new Error("TRANSACTION_CHANGED")
    }

    if (transaction.category?.toLowerCase() === "transfer") {
      throw new Error("TRANSFER_TRANSACTION_LOCKED")
    }

    const balances = await getAccountBalances(
      connection,
      [accountId],
    )

    const currentBalance = balances.get(accountId)!

    const delta = transactionDelta(
      transaction.type,
      Number(transaction.amount),
    )

    // Menghapus pemasukan dapat membuat saldo negatif.
    // Tolak penghapusan jika hal tersebut terjadi.
    const resultingBalance = currentBalance - delta

    if (resultingBalance < 0) {
      throw new Error("INSUFFICIENT_BALANCE")
    }

    await connection.execute<ResultSetHeader>(
      "DELETE FROM transactions WHERE id = ?",
      [id],
    )

    await connection.commit()
    transactionStarted = false

    res.json({
      message: "Transaksi berhasil dihapus.",
    })
  } catch (error) {
    if (connection) {
      await safeRollback(connection, transactionStarted)
    }

    sendTransactionError(error, res, next)
  } finally {
    connection?.release()
  }
}

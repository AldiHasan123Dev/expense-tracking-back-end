
import type { Request, Response, NextFunction } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { pool } from "../config/db.js";

interface TransactionRow extends RowDataPacket {
  id: number;
  account_id: number;
  title: string;
  amount: number;
  type: "income" | "expense";
  category: string;
  date: string;
}

interface AccountRow extends RowDataPacket {
  id: number;
  initial_balance: number;
}

type TransactionType = "income" | "expense";

interface TransactionInput {
  account_id: number;
  title: string;
  amount: number;
  type: TransactionType;
  category: string;
  date: string;
}

function validBody(body: Record<string, unknown>): boolean {
  if (
    typeof body.title !== "string" ||
    body.title.trim().length === 0 ||
    body.title.trim().length > 150
  ) {
    return false;
  }

  if (
    typeof body.amount !== "number" ||
    !Number.isSafeInteger(body.amount) ||
    body.amount <= 0
  ) {
    return false;
  }

  if (body.type !== "income" && body.type !== "expense") {
    return false;
  }

  if (
    typeof body.category !== "string" ||
    body.category.trim().length === 0 ||
    body.category.trim().length > 100
  ) {
    return false;
  }

  if (
    typeof body.account_id !== "number" ||
    !Number.isSafeInteger(body.account_id) ||
    body.account_id <= 0
  ) {
    return false;
  }

  if (
    typeof body.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(body.date)
  ) {
    return false;
  }

  const parsedDate = new Date(`${body.date}T00:00:00Z`);

  return (
    !Number.isNaN(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === body.date
  );
}

function validId(value: string | string[]): number | null {
  const idValue = Array.isArray(value) ? value[0] : value;

  if (!idValue || !/^[1-9]\d*$/.test(idValue)) {
    return null;
  }

  const id = Number(idValue);

  return Number.isSafeInteger(id) ? id : null;
}

function transactionDelta(
  type: TransactionType,
  amount: number
): number {
  return type === "income" ? amount : -amount;
}

function readInput(body: Record<string, unknown>): TransactionInput {
  return {
    account_id: body.account_id as number,
    title: (body.title as string).trim(),
    amount: body.amount as number,
    type: body.type as TransactionType,
    category: (body.category as string).trim(),
    date: body.date as string,
  };
}

const selectSql = `
  SELECT
    id,
    account_id,
    title,
    amount,
    type,
    category,
    DATE_FORMAT(date, '%Y-%m-%d') AS date
  FROM transactions
`;

function serializeTransaction(row: TransactionRow) {
  return {
    ...row,
    id: Number(row.id),
    account_id: Number(row.account_id),
    amount: Number(row.amount),
  };
}

async function lockAccounts(
  connection: PoolConnection,
  accountIds: number[]
): Promise<Map<number, number>> {
  const balances = new Map<number, number>();
  const uniqueIds = [...new Set(accountIds)].sort((a, b) => a - b);

  // Lock in ascending ID order to reduce deadlock risk.
  for (const accountId of uniqueIds) {
    const [rows] = await connection.execute<AccountRow[]>(
      `SELECT id, initial_balance FROM accounts WHERE id = ? FOR UPDATE`,
      [accountId]
    );

    if (rows.length === 0) {
      throw new Error("ACCOUNT_NOT_FOUND");
    }

    balances.set(Number(rows[0].id), Number(rows[0].balance));
  }

  return balances;
}

async function changeBalance(
  connection: PoolConnection,
  accountId: number,
  delta: number
): Promise<void> {
  const [result] = await connection.execute<ResultSetHeader>(
    `UPDATE accounts SET initial_balance = initial_balance + ? WHERE id = ?`,
    [delta, accountId]
  );

  if (result.affectedRows !== 1) {
    throw new Error("ACCOUNT_NOT_FOUND");
  }
}

function sendTransactionError(
  error: unknown,
  res: Response,
  next: NextFunction
): void {
  if (error instanceof Error && error.message === "ACCOUNT_NOT_FOUND") {
    res.status(404).json({ message: "Rekening tidak ditemukan." });
    return;
  }

  if (error instanceof Error && error.message === "INSUFFICIENT_BALANCE") {
    res.status(422).json({
      message: "Saldo rekening tidak mencukupi untuk pengeluaran ini.",
    });
    return;
  }

  next(error);
}

// GET /api/transactions
export async function index(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const [rows] = await pool.execute<TransactionRow[]>(
      `${selectSql} ORDER BY date DESC, id DESC`
    );

    res.json(rows.map(serializeTransaction));
  } catch (error) {
    next(error);
  }
}

// GET /api/transactions/:id
export async function show(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = validId(req.params.id);

    if (id === null) {
      res.status(400).json({ message: "ID tidak valid." });
      return;
    }

    const [rows] = await pool.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) {
      res.status(404).json({ message: "Transaksi tidak ditemukan." });
      return;
    }

    res.json(serializeTransaction(rows[0]));
  } catch (error) {
    next(error);
  }
}

// POST /api/transactions
export async function store(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const connection = await pool.getConnection();

  try {
    if (!validBody(req.body)) {
      res.status(422).json({
        message: "Data transaksi tidak valid. Pastikan account_id dipilih.",
      });
      return;
    }

    const input = readInput(req.body);

    await connection.beginTransaction();

    const balances = await lockAccounts(connection, [input.account_id]);
    const currentBalance = balances.get(input.account_id)!;
    const delta = transactionDelta(input.type, input.amount);

    if (currentBalance + delta < 0) {
      throw new Error("INSUFFICIENT_BALANCE");
    }

    const [result] = await connection.execute<ResultSetHeader>(
      `INSERT INTO transactions
        (account_id, title, amount, type, category, date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.account_id,
        input.title,
        input.amount,
        input.type,
        input.category,
        input.date,
      ]
    );

    await changeBalance(connection, input.account_id, delta);

    const [rows] = await connection.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [result.insertId]
    );

    if (rows.length === 0) {
      throw new Error("TRANSACTION_READ_FAILED");
    }

    await connection.commit();

    res.status(201).json(serializeTransaction(rows[0]));
  } catch (error) {
    await connection.rollback();
    sendTransactionError(error, res, next);
  } finally {
    connection.release();
  }
}

// PUT /api/transactions/:id
export async function update(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const connection = await pool.getConnection();

  try {
    const id = validId(req.params.id);

    if (id === null) {
      res.status(400).json({ message: "ID tidak valid." });
      return;
    }

    if (!validBody(req.body)) {
      res.status(422).json({
        message: "Data transaksi tidak valid. Pastikan account_id dipilih.",
      });
      return;
    }

    const input = readInput(req.body);

    await connection.beginTransaction();

    const [oldRows] = await connection.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ? FOR UPDATE`,
      [id]
    );

    if (oldRows.length === 0) {
      await connection.rollback();
      res.status(404).json({ message: "Transaksi tidak ditemukan." });
      return;
    }

    const oldTransaction = oldRows[0];

    const balances = await lockAccounts(connection, [
      Number(oldTransaction.account_id),
      input.account_id,
    ]);

    const oldAccountId = Number(oldTransaction.account_id);
    const oldDelta = transactionDelta(
      oldTransaction.type,
      Number(oldTransaction.amount)
    );
    const newDelta = transactionDelta(input.type, input.amount);

    // Reverse the previous transaction's effect.
    const restoredOldBalance = balances.get(oldAccountId)! - oldDelta;

    // If the account stays the same, evaluate the new transaction
    // against the balance after reversing the old transaction.
    const newAccountBalance =
      input.account_id === oldAccountId
        ? restoredOldBalance
        : balances.get(input.account_id)!;

    if (newAccountBalance + newDelta < 0) {
      throw new Error("INSUFFICIENT_BALANCE");
    }

    await changeBalance(connection, oldAccountId, -oldDelta);
    await changeBalance(connection, input.account_id, newDelta);

    await connection.execute<ResultSetHeader>(
      `UPDATE transactions
       SET account_id = ?, title = ?, amount = ?, type = ?, category = ?, date = ?
       WHERE id = ?`,
      [
        input.account_id,
        input.title,
        input.amount,
        input.type,
        input.category,
        input.date,
        id,
      ]
    );

    const [rows] = await connection.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) {
      throw new Error("TRANSACTION_READ_FAILED");
    }

    await connection.commit();

    res.json(serializeTransaction(rows[0]));
  } catch (error) {
    await connection.rollback();
    sendTransactionError(error, res, next);
  } finally {
    connection.release();
  }
}

// DELETE /api/transactions/:id
export async function destroy(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const connection = await pool.getConnection();

  try {
    const id = validId(req.params.id);

    if (id === null) {
      res.status(400).json({ message: "ID tidak valid." });
      return;
    }

    await connection.beginTransaction();

    const [rows] = await connection.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ? FOR UPDATE`,
      [id]
    );

    if (rows.length === 0) {
      await connection.rollback();
      res.status(404).json({ message: "Transaksi tidak ditemukan." });
      return;
    }

    const transaction = rows[0];
    const accountId = Number(transaction.account_id);

    await lockAccounts(connection, [accountId]);

    // Reverse the transaction's effect on the account balance.
    const delta = transactionDelta(
      transaction.type,
      Number(transaction.amount)
    );

    await changeBalance(connection, accountId, -delta);

    await connection.execute<ResultSetHeader>(
      `DELETE FROM transactions WHERE id = ?`,
      [id]
    );

    await connection.commit();

    res.json({ message: "Transaksi berhasil dihapus." });
  } catch (error) {
    await connection.rollback();
    sendTransactionError(error, res, next);
  } finally {
    connection.release();
  }
}

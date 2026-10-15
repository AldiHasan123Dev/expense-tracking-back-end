
import type { Request, Response, NextFunction } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../config/db.js";

interface TransactionRow extends RowDataPacket {
  id: number;
  title: string;
  amount: number;
  type: "income" | "expense";
  category: string;
  date: string;
}

// Memvalidasi data transaksi
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

// Memvalidasi ID transaksi
function validId(value: string | string[]): number | null {
  const idValue = Array.isArray(value) ? value[0] : value;

  if (!idValue || !/^[1-9]\d*$/.test(idValue)) {
    return null;
  }

  const id = Number(idValue);

  return Number.isSafeInteger(id) ? id : null;
}

// Query dasar transaksi
const selectSql = `
  SELECT
    id,
    title,
    amount,
    type,
    category,
    DATE_FORMAT(date, '%Y-%m-%d') AS date
  FROM transactions
`;

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

    res.json(
      rows.map((row) => ({
        ...row,
        amount: Number(row.amount),
      }))
    );
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
      res.status(404).json({
        message: "Transaksi tidak ditemukan.",
      });
      return;
    }

    res.json({
      ...rows[0],
      amount: Number(rows[0].amount),
    });
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
  try {
    if (!validBody(req.body)) {
      res.status(422).json({
        message: "Data transaksi tidak valid.",
      });
      return;
    }

    const { title, amount, type, category, date } = req.body;

    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO transactions
        (title, amount, type, category, date)
       VALUES (?, ?, ?, ?, ?)`,
      [
        title.trim(),
        amount,
        type,
        category.trim(),
        date,
      ]
    );

    const [rows] = await pool.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [result.insertId]
    );

    if (rows.length === 0) {
      res.status(500).json({
        message: "Transaksi tersimpan, tetapi gagal dibaca kembali.",
      });
      return;
    }

    res.status(201).json({
      ...rows[0],
      amount: Number(rows[0].amount),
    });
  } catch (error) {
    next(error);
  }
}

// PUT /api/transactions/:id
export async function update(
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

    if (!validBody(req.body)) {
      res.status(422).json({
        message: "Data transaksi tidak valid.",
      });
      return;
    }

    const { title, amount, type, category, date } = req.body;

    const [rowsBefore] = await pool.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [id]
    );

    if (rowsBefore.length === 0) {
      res.status(404).json({
        message: "Transaksi tidak ditemukan.",
      });
      return;
    }

    await pool.execute<ResultSetHeader>(
      `UPDATE transactions
       SET title = ?, amount = ?, type = ?, category = ?, date = ?
       WHERE id = ?`,
      [
        title.trim(),
        amount,
        type,
        category.trim(),
        date,
        id,
      ]
    );

    const [rows] = await pool.execute<TransactionRow[]>(
      `${selectSql} WHERE id = ?`,
      [id]
    );

    if (rows.length === 0) {
      res.status(404).json({
        message: "Transaksi tidak ditemukan.",
      });
      return;
    }

    res.json({
      ...rows[0],
      amount: Number(rows[0].amount),
    });
  } catch (error) {
    next(error);
  }
}

// DELETE /api/transactions/:id
export async function destroy(
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

    const [result] = await pool.execute<ResultSetHeader>(
      "DELETE FROM transactions WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      res.status(404).json({
        message: "Transaksi tidak ditemukan.",
      });
      return;
    }

    res.json({
      message: "Transaksi berhasil dihapus.",
    });
  } catch (error) {
    next(error);
  }
}

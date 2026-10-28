import type { Request, Response } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "../config/db.js";

interface GoalRow extends RowDataPacket {
  id: number;
  name: string;
  target_amount: number;
  target_date: string | null;
  description: string | null;
  saved_amount: number;
}

interface MovementRow extends RowDataPacket {
  id: number;
  goal_id: number;
  type: "deposit" | "withdrawal";
  amount: number;
  note: string | null;
  movement_date: string;
}

function validAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function validOptionalDate(value: unknown): boolean {
  return value === null || value === "" || validDate(value);
}

function validGoalPayload(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";

  const description =
    typeof body.description === "string" ? body.description.trim() : "";

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
  };
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
`;

function normalizeGoal(row: GoalRow) {
  const target = Number(row.target_amount);
  const saved = Number(row.saved_amount);

  return {
    ...row,
    target_amount: target,
    saved_amount: saved,
    remaining_amount: Math.max(target - saved, 0),
    progress: target > 0 ? Math.round((saved / target) * 10000) / 100 : 0,
    is_completed: saved >= target,
  };
}

export async function getGoals(_req: Request, res: Response): Promise<void> {
  try {
    const [rows] = await pool.query<GoalRow[]>(`
      ${goalSelect}
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `);

    res.json(rows.map(normalizeGoal));
  } catch (error) {
    console.error("Gagal mengambil target tabungan:", error);
    res.status(500).json({
      message: "Gagal mengambil target tabungan.",
    });
  }
}

export async function createGoal(req: Request, res: Response): Promise<void> {
  try {
    const input = validGoalPayload(req.body);

    if (!input.valid) {
      res.status(400).json({
        message: "Periksa nama, nominal, tanggal, dan deskripsi target.",
      });
      return;
    }

    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO savings_goals
        (name, target_amount, target_date, description)
       VALUES (?, ?, ?, ?)`,
      [input.name, input.targetAmount, input.targetDate, input.description],
    );

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
    });
  } catch (error) {
    console.error("Gagal membuat target:", error);
    res.status(500).json({
      message: "Gagal membuat target tabungan.",
    });
  }
}

export async function updateGoal(req: Request, res: Response): Promise<void> {
  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({ message: "ID target tidak valid." });
      return;
    }

    const input = validGoalPayload(req.body);

    if (!input.valid) {
      res.status(400).json({
        message: "Periksa nama, nominal, tanggal, dan deskripsi target.",
      });
      return;
    }

    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE savings_goals
       SET name = ?, target_amount = ?, target_date = ?, description = ?
       WHERE id = ?`,
      [input.name, input.targetAmount, input.targetDate, input.description, id],
    );

    if (result.affectedRows === 0) {
      res.status(404).json({ message: "Target tidak ditemukan." });
      return;
    }

    res.json({ message: "Target berhasil diperbarui." });
  } catch (error) {
    console.error("Gagal memperbarui target:", error);
    res.status(500).json({
      message: "Gagal memperbarui target tabungan.",
    });
  }
}

export async function deleteGoal(req: Request, res: Response): Promise<void> {
  const connection = await pool.getConnection();

  try {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({
        message: "ID target tidak valid.",
      });
      return;
    }

    await connection.beginTransaction();

    // Ambil dan kunci target tabungan
    const [goals] = await connection.query<RowDataPacket[]>(
      `SELECT id, name
       FROM savings_goals
       WHERE id = ?
       FOR UPDATE`,
      [id],
    );

    if (goals.length === 0) {
      await connection.rollback();

      res.status(404).json({
        message: "Target tidak ditemukan.",
      });
      return;
    }

    const goalName = String(goals[0].name);

    // Hitung saldo tabungan yang masih tersisa
    const [balanceRows] = await connection.query<RowDataPacket[]>(
      `SELECT COALESCE(
        SUM(
          CASE
            WHEN type = 'deposit' THEN amount
            ELSE -amount
          END
        ), 0
      ) AS initial_balance
      FROM savings_movements
      WHERE goal_id = ?`,
      [id],
    );

    const balance = Number(balanceRows[0].balance);

    // Kembalikan saldo ke kas jika masih ada sisa tabungan
    if (balance > 0) {
      await connection.query<ResultSetHeader>(
        `INSERT INTO transactions
          (title, amount, type, category, date)
         VALUES (?, ?, ?, ?, ?)`,
        [
          `Pengembalian Tabungan ${goalName}`,
          balance,
          "income",
          "Tabungan",
          new Date().toISOString().slice(0, 10),
        ],
      );
    }

    // Hapus target tabungan
    const [result] = await connection.query<ResultSetHeader>(
      "DELETE FROM savings_goals WHERE id = ?",
      [id],
    );

    if (result.affectedRows === 0) {
      await connection.rollback();

      res.status(404).json({
        message: "Target tidak ditemukan.",
      });
      return;
    }

    await connection.commit();

    res.json({
      message:
        balance > 0
          ? "Target dihapus dan saldo tabungan dikembalikan sebagai pemasukan."
          : "Target dan riwayatnya berhasil dihapus.",
      returned_amount: balance,
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error("Gagal melakukan rollback:", rollbackError);
    }

    console.error("Gagal menghapus target:", error);

    res.status(500).json({
      message: "Gagal menghapus target tabungan.",
    });
  } finally {
    connection.release();
  }
}

export async function getMovements(req: Request, res: Response): Promise<void> {
  try {
    const goalId = Number(req.params.id);

    if (!Number.isSafeInteger(goalId) || goalId <= 0) {
      res.status(400).json({ message: "ID target tidak valid." });
      return;
    }

    const [goals] = await pool.query<RowDataPacket[]>(
      "SELECT id FROM savings_goals WHERE id = ?",
      [goalId],
    );

    if (goals.length === 0) {
      res.status(404).json({ message: "Target tidak ditemukan." });
      return;
    }

    
const [rows] = await pool.query<MovementRow[]>(
  `SELECT
     id,
     goal_id,
     account_id,
     type,
     amount,
     note,
     DATE_FORMAT(movement_date, '%Y-%m-%d') AS movement_date
   FROM savings_movements
   WHERE goal_id = ?
   ORDER BY movement_date DESC, id DESC`,
  [goalId],
);


    res.json(
      rows.map((row) => ({
        ...row,
        amount: Number(row.amount),
      })),
    );
  } catch (error) {
    console.error("Gagal mengambil riwayat tabungan:", error);
    res.status(500).json({
      message: "Gagal mengambil riwayat tabungan.",
    });
  }
}

export async function createMovement(
  req: Request,
  res: Response,
): Promise<void> {
  const connection = await pool.getConnection();

  try {
    const goalId = Number(req.params.id);

    const {
      type,
      amount,
      note,
      movement_date,
      account_id,
    } = req.body as {
      type?: unknown;
      amount?: unknown;
      note?: unknown;
      movement_date?: unknown;
      account_id?: unknown;
    };

    if (
      !Number.isSafeInteger(goalId) ||
      goalId <= 0 ||
      (type !== "deposit" && type !== "withdrawal") ||
      !validAmount(amount) ||
      !Number.isSafeInteger(account_id) ||
      Number(account_id) <= 0 ||
      (note !== undefined &&
        note !== null &&
        (typeof note !== "string" || note.trim().length > 255)) ||
      (movement_date !== undefined && !validDate(movement_date))
    ) {
      res.status(400).json({
        message: "Data setoran atau penarikan tidak valid.",
      });
      return;
    }

    const accountId = Number(account_id);
    const effectiveDate =
      movement_date ?? new Date().toISOString().slice(0, 10);

    const normalizedNote =
      typeof note === "string" ? note.trim() || null : null;

    await connection.beginTransaction();

    // 1. Kunci target tabungan.
    const [goals] = await connection.query<RowDataPacket[]>(
      `SELECT id, name
       FROM savings_goals
       WHERE id = ?
       FOR UPDATE`,
      [goalId],
    );

    if (goals.length === 0) {
      await connection.rollback();
      res.status(404).json({
        message: "Target tidak ditemukan.",
      });
      return;
    }

    const goalName = String(goals[0].name);

    // 2. Kunci rekening yang dipilih.
    const [accountRows] = await connection.query<RowDataPacket[]>(
      `SELECT id, initial_balance
       FROM accounts
       WHERE id = ?
       FOR UPDATE`,
      [accountId],
    );

    if (accountRows.length === 0) {
      await connection.rollback();
      res.status(404).json({
        message: "Rekening tidak ditemukan.",
      });
      return;
    }

    const accountBalance = Number(accountRows[0].balance);

    // 3. Untuk setoran, pastikan saldo rekening mencukupi.
    if (type === "deposit" && amount > accountBalance) {
      await connection.rollback();
      res.status(400).json({
        message: "Saldo rekening tidak mencukupi untuk setoran.",
      });
      return;
    }

    // 4. Untuk penarikan, periksa saldo target tabungan.
    if (type === "withdrawal") {
      const [balanceRows] = await connection.query<RowDataPacket[]>(
        `SELECT COALESCE(
          SUM(
            CASE
              WHEN type = 'deposit' THEN amount
              ELSE -amount
            END
          ), 0
        ) AS initial_balance
        FROM savings_movements
        WHERE goal_id = ?`,
        [goalId],
      );

      const savingsBalance = Number(balanceRows[0].balance);

      if (amount > savingsBalance) {
        await connection.rollback();
        res.status(400).json({
          message: "Penarikan melebihi saldo tabungan yang tersedia.",
        });
        return;
      }
    }

    // 5. Perbarui saldo rekening.
    if (type === "deposit") {
      const [updateResult] =
        await connection.query<ResultSetHeader>(
          `UPDATE accounts
           SET initial_balance = initial_balance - ?
           WHERE id = ? AND initial_balance >= ?`,
          [amount, accountId, amount],
        );

      if (updateResult.affectedRows === 0) {
        await connection.rollback();
        res.status(400).json({
          message: "Saldo rekening tidak mencukupi.",
        });
        return;
      }
    } else {
      await connection.query<ResultSetHeader>(
        `UPDATE accounts
         SET initial_balance = initial_balance + ?
         WHERE id = ?`,
        [amount, accountId],
      );
    }

    // 6. Simpan riwayat tabungan beserta rekeningnya.
    const [movementResult] =
      await connection.query<ResultSetHeader>(
        `INSERT INTO savings_movements
          (goal_id, account_id, type, amount, note, movement_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          goalId,
          accountId,
          type,
          amount,
          normalizedNote,
          effectiveDate,
        ],
      );

    // 7. Catat transaksi keuangan.
    const transactionType =
      type === "deposit" ? "expense" : "income";

    const transactionTitle =
      type === "deposit"
        ? `Tabungan ${goalName}`
        : `Penarikan Tabungan ${goalName}`;

    await connection.query<ResultSetHeader>(
      `INSERT INTO transactions
        (title, amount, type, category, date, account_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        transactionTitle,
        amount,
        transactionType,
        "Tabungan",
        effectiveDate,
        accountId,
      ],
    );

    // 8. Simpan seluruh perubahan sekaligus.
    await connection.commit();

    res.status(201).json({
      id: movementResult.insertId,
      goal_id: goalId,
      account_id: accountId,
      type,
      amount,
      note: normalizedNote,
      movement_date: effectiveDate,
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error("Gagal melakukan rollback:", rollbackError);
    }

    console.error("Gagal mencatat tabungan:", error);

    res.status(500).json({
      message: "Gagal mencatat setoran atau penarikan.",
    });
  } finally {
    connection.release();
  }
}


export async function getWithdrawableDeposits(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const goalId = Number(req.params.id)
    const accountId = Number(req.query.account_id)

    if (
      !Number.isInteger(goalId) ||
      goalId <= 0 ||
      !Number.isInteger(accountId) ||
      accountId <= 0
    ) {
      res.status(400).json({
        message: "ID target tabungan atau rekening tidak valid.",
      })
      return
    }

    // Pastikan target tabungan tersedia.
    const [goalRows] = await pool.execute<RowDataPacket[]>(
      "SELECT id FROM savings_goals WHERE id = ? LIMIT 1",
      [goalId]
    )

    if (goalRows.length === 0) {
      res.status(404).json({
        message: "Target tabungan tidak ditemukan.",
      })
      return
    }

    // Ambil setoran yang masih memiliki saldo untuk ditarik.
    const [rows] = await pool.execute<RowDataPacket[]>(
      `
      SELECT
        sm.id AS movement_id,
        sm.transaction_id,
        sm.goal_id,
        sm.account_id,
        sm.amount,
        COALESCE(SUM(w.amount), 0) AS withdrawn_amount,
        GREATEST(
          sm.amount - COALESCE(SUM(w.amount), 0),
          0
        ) AS remaining_amount,
        DATE_FORMAT(sm.movement_date, '%Y-%m-%d') AS movement_date
      FROM savings_movements sm
      LEFT JOIN savings_movements w
        ON w.source_transaction_id = sm.transaction_id
        AND w.type = 'withdrawal'
      WHERE sm.goal_id = ?
        AND sm.account_id = ?
        AND sm.type = 'deposit'
        AND sm.transaction_id IS NOT NULL
      GROUP BY
        sm.id,
        sm.transaction_id,
        sm.goal_id,
        sm.account_id,
        sm.amount,
        sm.movement_date
      HAVING remaining_amount > 0
      ORDER BY sm.movement_date DESC, sm.id DESC
      `,
      [goalId, accountId]
    )

    res.status(200).json(rows)
  } catch (error) {
    console.error("getWithdrawableDeposits error:", error)

    res.status(500).json({
      message: "Gagal mengambil daftar setoran yang bisa ditarik.",
    })
  }
}

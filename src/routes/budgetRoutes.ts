
import { Router } from "express"
import {
  getBudgets,
  createBudget,
  deleteBudget,
} from "../controllers/budgetsController.js"

const router = Router()

router.get("/", getBudgets)
router.post("/", createBudget)
router.delete("/:id", deleteBudget)

export default router

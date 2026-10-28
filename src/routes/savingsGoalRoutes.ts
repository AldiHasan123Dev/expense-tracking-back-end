
import { Router } from "express"
import {
  getGoals,
  createGoal,
  updateGoal,
  deleteGoal,
  getMovements,
  createMovement,
  getWithdrawableDeposits,
} from "../controllers/savingsGoalController.js"

const router = Router()

router.get("/", getGoals)
router.post("/", createGoal)

router.get("/:id/movements", getMovements)
router.post("/:id/movements", createMovement)

router.put("/:id", updateGoal)
router.delete("/:id", deleteGoal)
router.get(
  "/:id/withdrawable-deposits",
  getWithdrawableDeposits
)

export default router

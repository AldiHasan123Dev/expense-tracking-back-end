import { Router } from "express"
import {
  index,
  show,
  store,
  update,
  destroy,
} from "../controllers/transactionController.js"

const router = Router()

router.get("/", index)
router.get("/:id", show)
router.post("/", store)
router.put("/:id", update)
router.delete("/:id", destroy)

export default router
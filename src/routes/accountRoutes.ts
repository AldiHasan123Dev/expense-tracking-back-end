
import { Router } from "express"
import {
  index,
  store,
  update,
  destroy,
  transfer,
} from "../controllers/accountController.js"

const router = Router()

// Daftar rekening.
router.get("/", index)

// Transfer saldo antar-rekening.
router.post("/transfers", transfer)

// CRUD rekening.
router.post("/", store)
router.put("/:id", update)
router.delete("/:id", destroy)

export default router

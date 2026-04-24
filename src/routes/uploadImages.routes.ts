import { Router, Request, Response } from "express";
import multer = require("multer");
import { UploadImageService } from "../services/uploadImage.service";

const router = Router();

// Store files in memory so we can access file.buffer directly
const upload = multer({ storage: multer.memoryStorage() });

// FIX 2: Create a local interface extending Request to force TypeScript to recognize '.file'
interface MulterRequest extends Request {
  file?: any;
}

/**
 * POST /api/images/upload
 * Expects a form-data field named 'image'
 */
// Use our new MulterRequest type here instead of standard Request
router.post(
  "/upload",
  upload.single("image"),
  async (req: MulterRequest, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const encryptedUrl = await UploadImageService.uploadEncryptedImage(
        req.file,
      );

      res.status(200).json({
        message: "Image encrypted and uploaded successfully",
        encryptedUrl,
      });
    } catch (error: any) {
      console.error("Upload Error:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

router.post(
  "/upload-profile",
  upload.single("image"),
  async (req: MulterRequest, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const encryptedUrl = await UploadImageService.uploadProfileImage(
        req.file,
      );

      res.status(200).json({
        message: "profile uploaded successfully",
        encryptedUrl,
      });
    } catch (error: any) {
      console.error("Upload Error:", error);
      res.status(500).json({ error: error.message });
    }
  },
);


/**
 * GET /api/images/decrypt/:fileName
 * Downloads the encrypted file, decrypts it, and serves it as a viewable image
 */
router.get("/decrypt/:fileName", async (req: Request, res: Response) => {
  try {
    const { fileName } = req.params;

    const decryptedBuffer =
      await UploadImageService.downloadAndDecryptImage(fileName);

    // Set the appropriate headers so the browser renders it as an image
    res.setHeader("Content-Type", "image/jpeg");
    res.send(decryptedBuffer);
  } catch (error: any) {
    console.error("Decrypt Error:", error);
    res.status(500).json({ error: error.message });
  }
});

export { router as uploadRouter };

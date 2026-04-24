import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

export interface MulterFile {
  buffer: Buffer;
  originalname: string;
}

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL as string;
const supabaseKey = process.env.SUPABASE_ANON_KEY as string;
const encryptionKey = process.env.ENCRYPTION_KEY as string;
const bucketName = process.env.SUPABASE_BUCKET as string;
const profileBucketName = process.env.SUPABASE_PROFILE_BUCKET as string;
const supabase = createClient(supabaseUrl, supabaseKey);

// AES-256-CBC requires a 32-byte key and a 16-byte Initialization Vector (IV)
const ALGORITHM = "aes-256-cbc";

export const UploadImageService = {
  /**
   * Encrypts a raw image buffer
   */
  encryptBuffer(buffer: Buffer): Buffer {
    const iv = crypto.randomBytes(16); // Generate a new IV for every encryption
    const cipher = crypto.createCipheriv(
      ALGORITHM,
      Buffer.from(encryptionKey),
      iv,
    );

    let encrypted = cipher.update(buffer);
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    // Prepend the IV to the encrypted data so we can use it during decryption
    return Buffer.concat([iv, encrypted]);
  },

  /**
   * Decrypts an encrypted buffer back to the original image
   */
  decryptBuffer(encryptedBuffer: Buffer): Buffer {
    // Extract the first 16 bytes as the IV, and the rest as the actual encrypted data
    const iv = encryptedBuffer.subarray(0, 16);
    const encryptedData = encryptedBuffer.subarray(16);

    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      Buffer.from(encryptionKey),
      iv,
    );

    let decrypted = decipher.update(encryptedData);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted;
  },

  /**
   * Encrypts and uploads the file to Supabase, returning the URL
   */
  async uploadEncryptedImage(file: MulterFile): Promise<string> {
    const encryptedBuffer = this.encryptBuffer(file.buffer);

    // Create a unique filename (we save it as a .bin or .enc since it's no longer a raw image)
    const fileName = `${Date.now()}-${file.originalname}.enc`;

    const { data, error } = await supabase.storage
      .from(bucketName)
      .upload(fileName, encryptedBuffer, {
        contentType: "application/octet-stream", // Crucial: It's raw encrypted binary now
      });

    if (error) throw new Error(`Supabase upload failed: ${error.message}`);

    // Return the public URL to the encrypted blob
    const { data: publicUrlData } = supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return publicUrlData.publicUrl;
  },

  async uploadProfileImage(file: MulterFile): Promise<string> {
    // 1. Create a unique filename (keeping the original file extension)
    // We also replace spaces with underscores to prevent broken URLs
    const cleanFileName = file.originalname.replace(/\s+/g, "_");
    const fileName = `profile-${Date.now()}-${cleanFileName}`;

    // 2. Upload the raw, unencrypted buffer directly to Supabase
    const { data, error } = await supabase.storage
      .from(profileBucketName) // Note: You might want a separate bucket like "profile-images" for these
      .upload(fileName, file.buffer, {
        // Use the file's actual mime type (e.g., 'image/jpeg' or 'image/png')
        // If your custom MulterFile interface doesn't have mimetype, default to 'image/jpeg'
        contentType: (file as any).mimetype || "image/jpeg",
        upsert: false,
      });

    if (error)
      throw new Error(`Supabase profile upload failed: ${error.message}`);

    // 3. Retrieve and return the public URL
    const { data: publicUrlData } = supabase.storage
      .from(profileBucketName)
      .getPublicUrl(fileName);

    return publicUrlData.publicUrl;
  },

  /**
   * Downloads the encrypted file from Supabase and decrypts it
   */
  async downloadAndDecryptImage(fileName: string): Promise<Buffer> {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .download(fileName);

    if (error) throw new Error(`Supabase download failed: ${error.message}`);

    // Convert Blob to ArrayBuffer, then to Node Buffer
    const arrayBuffer = await data.arrayBuffer();
    const encryptedBuffer = Buffer.from(arrayBuffer);

    // Decrypt and return the original image buffer
    return this.decryptBuffer(encryptedBuffer);
  },
};

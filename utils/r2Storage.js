const { GetObjectCommand, PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const crypto = require("crypto");

const requiredEnv = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_ENDPOINT",
];

const getR2Client = () => {
  const missing = requiredEnv.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing Cloudflare R2 env values: ${missing.join(", ")}`);
  }

  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
};

const getExtension = (fileName = "") => {
  const extension = fileName.split(".").pop();
  return extension && extension !== fileName ? `.${extension.toLowerCase()}` : "";
};

const parseDataUrl = (file) => {
  if (!file?.data || !file?.fileName || !file?.mimeType) {
    throw new Error("Invalid file upload");
  }

  const match = file.data.match(/^data:(.+);base64,(.+)$/);

  if (!match) {
    throw new Error("Invalid file format");
  }

  return {
    buffer: Buffer.from(match[2], "base64"),
    mimeType: file.mimeType || match[1],
  };
};

exports.uploadVerificationIdCard = async (file) => {
  const { buffer, mimeType } = parseDataUrl(file);
  const key = `verification-id-cards/${Date.now()}-${crypto.randomUUID()}${getExtension(
    file.fileName,
  )}`;

  await getR2Client().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }),
  );

  return {
    fileName: file.fileName,
    mimeType,
    key,
    size: buffer.length,
  };
};

exports.getVerificationIdCard = async (key) =>
  getR2Client().send(
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }),
  );

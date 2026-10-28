import { S3Storage } from "coze-coding-dev-sdk";

/**
 * 对象存储单例
 * 用于将前端上传的文件转存到 S3，获取可被 WF10 工作流访问的签名 URL
 */
let storageInstance: S3Storage | null = null;

export function getStorage(): S3Storage | null {
  if (storageInstance) return storageInstance;

  const endpoint = process.env.COZE_BUCKET_ENDPOINT_URL;
  const bucket = process.env.COZE_BUCKET_NAME;

  if (!endpoint || !bucket) {
    return null;
  }

  storageInstance = new S3Storage({
    endpointUrl: endpoint,
    accessKey: "",
    secretKey: "",
    bucketName: bucket,
    region: "cn-beijing",
  });

  return storageInstance;
}

/**
 * 判断对象存储是否可用（环境变量是否配置）
 */
export function isStorageAvailable(): boolean {
  return !!process.env.COZE_BUCKET_ENDPOINT_URL && !!process.env.COZE_BUCKET_NAME;
}

/**
 * 上传文件到对象存储，并返回签名 URL（有效期 24 小时）
 * @param fileContent 文件内容 Buffer
 * @param fileName 原始文件名
 * @param contentType MIME 类型
 * @returns 签名 URL，或 null（存储未配置时）
 */
export async function uploadAndGetSignedUrl(
  fileContent: Buffer,
  fileName: string,
  contentType: string,
): Promise<string | null> {
  const storage = getStorage();
  if (!storage) return null;

  // 安全文件名：替换非法字符，保留扩展名
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const prefixedName = `report-uploads/${Date.now()}_${safeName}`;

  const key = await storage.uploadFile({
    fileContent,
    fileName: prefixedName,
    contentType,
  });

  const signedUrl = await storage.generatePresignedUrl({
    key,
    expireTime: 86400, // 24 小时，足够工作流处理
  });

  return signedUrl;
}

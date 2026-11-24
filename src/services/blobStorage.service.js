const { Readable } = require('node:stream');
const { put, get, del } = require('@vercel/blob');

function getBlobToken() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error(
      'Falta la variable de entorno BLOB_READ_WRITE_TOKEN para el store privado inpa-go-store.'
    );
  }
  return token;
}

function assertSafeBlobPathname(pathname) {
  if (typeof pathname !== 'string' || !pathname.trim()) {
    throw new Error('Ruta de archivo en Vercel Blob inválida.');
  }
  const clean = pathname.trim();
  if (
    clean.startsWith('/') ||
    clean.includes('..') ||
    clean.includes('\\') ||
    /[\x00-\x1f]/.test(clean)
  ) {
    throw new Error('Ruta de archivo en Vercel Blob rechazada por validación de seguridad.');
  }
  return clean;
}

async function uploadPrivateBlob(pathname, buffer, contentType) {
  const safePath = assertSafeBlobPathname(pathname);
  const blob = await put(safePath, buffer, {
    access: 'private',
    contentType,
    addRandomSuffix: false,
    token: getBlobToken(),
  });
  return blob.pathname;
}

async function getPrivateBlobStream(pathname) {
  if (!pathname) {
    return null;
  }

  const safePath = assertSafeBlobPathname(pathname);
  const result = await get(safePath, {
    access: 'private',
    token: getBlobToken(),
  });

  if (!result || result.statusCode === 404 || !result.stream) {
    return null;
  }

  return {
    stream: Readable.fromWeb(result.stream),
    contentType: result.blob?.contentType || 'application/octet-stream',
    size: result.blob?.size,
  };
}

async function getPrivateBlobBuffer(pathname) {
  const blobStream = await getPrivateBlobStream(pathname);
  if (!blobStream) {
    return null;
  }

  const chunks = [];
  for await (const chunk of blobStream.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function deletePrivateBlob(pathname) {
  if (!pathname) {
    return;
  }
  const safePath = assertSafeBlobPathname(pathname);
  await del(safePath, {
    token: getBlobToken(),
  });
}

module.exports = {
  assertSafeBlobPathname,
  uploadPrivateBlob,
  getPrivateBlobStream,
  getPrivateBlobBuffer,
  deletePrivateBlob,
};

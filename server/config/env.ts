import path from 'node:path';

const DEFAULT_DB_FILE_PATH = path.resolve(process.cwd(), '.data', 'smartqueue-db.json');

function resolveDbFilePath(rawPath: string | undefined): string {
  const trimmed = rawPath?.trim();
  if (!trimmed) {
    return DEFAULT_DB_FILE_PATH;
  }
  // Guard against database connection URIs (e.g., mongodb+srv://) or trailing directory paths
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) || trimmed.endsWith('/') || trimmed.endsWith('\\')) {
    console.warn(
      `Invalid SMARTQUEUE_DB_PATH (expected a local file path, got a URI or directory). Falling back to ${DEFAULT_DB_FILE_PATH}`
    );
    return DEFAULT_DB_FILE_PATH;
  }
  return path.resolve(trimmed);
}

const DEFAULT_MONGODB_DB_NAME = 'smartqueue';

function resolveMongoUri(rawUri: string | undefined): string {
  let trimmed = rawUri?.trim() || '';
  if (!trimmed) return '';

  // Strip accidental < > placeholder brackets around credentials in mongodb:// or mongodb+srv:// URIs
  trimmed = trimmed.replace(
    /^(mongodb(?:\+srv)?:\/\/)([^/@?]+):([^/@?]+)@/,
    (_full, scheme: string, user: string, pass: string) => {
      const cleanUser = user.replace(/^<(.+)>$/, '$1');
      const cleanPass = pass.replace(/^<(.+)>$/, '$1');
      return `${scheme}${cleanUser}:${cleanPass}@`;
    }
  );

  // Strip invalid database name path segments (e.g., containing '.') so MongoClient doesn't fail on connect
  trimmed = trimmed.replace(
    /^(mongodb(?:\+srv)?:\/\/[^/?]+)\/([^?]*)/,
    (full, base: string, dbPath: string) => {
      if (!dbPath) return full;
      if (/[./\\"$*<>:|?\s]/.test(dbPath)) {
        return `${base}/`;
      }
      return full;
    }
  );

  return trimmed;
}

function resolveMongoDbName(rawDbName: string | undefined): string {
  const trimmed = rawDbName?.trim();
  if (!trimmed) {
    return DEFAULT_MONGODB_DB_NAME;
  }

  // MongoDB database names cannot contain '.', '/', '\', whitespace, or special symbols
  if (/[./\\"$*<>:|?\s]/.test(trimmed) || Buffer.byteLength(trimmed, 'utf8') > 63) {
    console.warn(
      `Invalid MONGODB_DB_NAME "${trimmed}" (database names cannot contain '.' or special characters). Falling back to "${DEFAULT_MONGODB_DB_NAME}".`
    );
    return DEFAULT_MONGODB_DB_NAME;
  }

  return trimmed;
}

export const ENV = {
  PORT: Number(process.env.PORT || 3000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  AUTH_SECRET:
    process.env.AUTH_SECRET || 'smartqueue-civic-dev-secret-change-in-production',
  REFRESH_SECRET:
    process.env.REFRESH_SECRET || 'smartqueue-refresh-dev-secret-change-in-production',
  ACCESS_TOKEN_TTL_SECONDS: 60 * 60 * 4, // 4 hours
  REFRESH_TOKEN_TTL_SECONDS: 60 * 60 * 24 * 14, // 14 days
  TOKEN_TTL_SECONDS: 60 * 60 * 24 * 7,
  DB_FILE_PATH: resolveDbFilePath(process.env.SMARTQUEUE_DB_PATH),
  MONGODB_URI: resolveMongoUri(process.env.MONGODB_URI),
  MONGODB_DB_NAME: resolveMongoDbName(process.env.MONGODB_DB_NAME),
};

declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    AZURE_SPEECH_KEY?: string;
    AZURE_SPEECH_REGION?: string;
    AZURE_TRANSLATOR_KEY?: string;
    AZURE_TRANSLATOR_REGION?: string;
  }
}

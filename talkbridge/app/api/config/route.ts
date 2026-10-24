import { response, speechReady } from "@/lib/server";

export function GET() {
  return response({ speechReady: speechReady(), demoAvailable: true, maxSessionMinutes: 30 });
}

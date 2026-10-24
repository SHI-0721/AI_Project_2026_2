import { route, speechToken } from "@/lib/server";

export function POST(request: Request) { return route(() => speechToken(request)); }

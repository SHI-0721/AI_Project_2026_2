import { getRoom, postRoom, route } from "@/lib/server";

export function GET(request: Request) { return route(() => getRoom(request)); }
export function POST(request: Request) { return route(() => postRoom(request)); }

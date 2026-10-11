import { createFileRoute } from "@tanstack/react-router";
import { Uthgaard } from "@/components/Uthgaard";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <Uthgaard />;
}

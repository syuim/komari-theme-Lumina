import { Outlet } from "react-router-dom";
import { FloatingControls } from "./FloatingControls";

export function AppShell() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <FloatingControls />
      <main className="flex-1 px-3 pb-8 pt-14 sm:px-5 md:px-6 lg:px-8 lg:pt-16">
        <div className="mx-auto w-full max-w-[1720px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

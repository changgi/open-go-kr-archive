"use client";

import { useRouter, useSearchParams } from "next/navigation";

interface Props {
  currentPage: number;
  totalPages: number;
}

export default function Pagination({ currentPage, totalPages }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  if (totalPages <= 1) return null;

  function goToPage(page: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(page));
    router.push(`/documents?${params.toString()}`);
  }

  const pages: number[] = [];
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(totalPages, currentPage + 2);
  for (let i = start; i <= end; i++) pages.push(i);

  return (
    <div className="flex items-center justify-center gap-1 mt-6">
      <button
        onClick={() => goToPage(currentPage - 1)}
        disabled={currentPage <= 1}
        className="px-3 py-1.5 text-sm rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-100"
      >
        이전
      </button>
      {pages.map((p) => (
        <button
          key={p}
          onClick={() => goToPage(p)}
          className={`px-3 py-1.5 text-sm rounded border ${
            p === currentPage
              ? "bg-primary-600 text-white border-primary-600"
              : "border-gray-300 hover:bg-gray-100"
          }`}
        >
          {p}
        </button>
      ))}
      <button
        onClick={() => goToPage(currentPage + 1)}
        disabled={currentPage >= totalPages}
        className="px-3 py-1.5 text-sm rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-100"
      >
        다음
      </button>
    </div>
  );
}

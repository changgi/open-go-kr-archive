import Link from "next/link";

export default function Header() {
  return (
    <header className="bg-primary-600 text-white shadow-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href="/" className="text-xl font-bold tracking-tight">
            원문정보 수집기
          </Link>
          <nav className="flex space-x-6">
            <Link href="/" className="hover:text-primary-200 transition-colors text-sm font-medium">
              대시보드
            </Link>
            <Link href="/documents" className="hover:text-primary-200 transition-colors text-sm font-medium">
              문서 목록
            </Link>
            <Link href="/stats" className="hover:text-primary-200 transition-colors text-sm font-medium">
              통계
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}

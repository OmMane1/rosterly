/** "Oct 8, 2026". A fixed locale, so every recruiter reads dates the same way. */
export const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

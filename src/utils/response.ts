export const ok = <T>(data: T, message = 'Success', statusCode = 200) =>
  ({ success: true, message, data, statusCode });

export function paginate(q: Record<string, any>) {
  const page  = Math.max(1, parseInt(String(q.page  || 1), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || 20), 10)));
  return { page, limit, skip: (page - 1) * limit };
}

export function paginatedResult<T>(items: T[], total: number, page: number, limit: number) {
  const totalPages = Math.ceil(total / limit) || 1;
  return {
    items,
    pagination: { total, page, limit, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
  };
}

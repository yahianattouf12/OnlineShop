namespace Shop.Api.Common.Paging;

/// <summary>One page of results plus what the client needs to show "page 2 of 7".</summary>
public record PagedResponse<T>(IReadOnlyList<T> Items, int Page, int PageSize, int TotalCount, int TotalPages)
{
    public static PagedResponse<T> Create(IReadOnlyList<T> items, int page, int pageSize, int totalCount) =>
        new(items, page, pageSize, totalCount, (int)Math.Ceiling(totalCount / (double)pageSize));
}

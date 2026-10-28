namespace Shop.Api.Common.Errors;

public abstract class AppException : Exception
{
    protected AppException(int statusCode, string title, string detail) : base(detail)
    {
        StatusCode = statusCode;
        Title = title;
    }

    public int StatusCode { get; }

    public string Title { get; }

    public Dictionary<string, object?> Extensions { get; } = new();
}

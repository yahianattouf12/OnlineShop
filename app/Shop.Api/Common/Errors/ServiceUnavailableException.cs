namespace Shop.Api.Common.Errors;

/// <summary>503: a service we depend on (e.g. inventory over gRPC) is down or too slow.</summary>
public sealed class ServiceUnavailableException : AppException
{
    public ServiceUnavailableException(string detail)
        : base(StatusCodes.Status503ServiceUnavailable, "Service unavailable", detail)
    {
    }
}

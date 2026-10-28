namespace Shop.Api.Common;

/// <summary>
/// Route prefixes. Every controller uses one, e.g. <c>[Route(ApiRoutes.V1 + "/orders")]</c>,
/// so the version lives in one place and every path starts with /api/v1.
/// </summary>
public static class ApiRoutes
{
    public const string V1 = "api/v1";
}

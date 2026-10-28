using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Shop.Api.Common;
using Shop.Api.Common.Auth;
using Shop.Api.Modules.Users.Dtos;

namespace Shop.Api.Modules.Users;

/// <summary>User management. Admin only: a customer gets 403.</summary>
[ApiController]
[Route(ApiRoutes.V1 + "/users")]
[Authorize(Roles = Roles.Admin)]
public class UsersController : ControllerBase
{
    private readonly UsersService _usersService;

    public UsersController(UsersService usersService)
    {
        _usersService = usersService;
    }

    [HttpGet]
    public Task<IReadOnlyList<UserResponse>> GetAll(CancellationToken ct) =>
        _usersService.GetAllAsync(ct);

    [HttpGet("{id:guid}")]
    public Task<UserResponse> GetById(Guid id, CancellationToken ct) =>
        _usersService.GetByIdAsync(id, ct);
}

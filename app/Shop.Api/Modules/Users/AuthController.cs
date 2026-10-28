using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Shop.Api.Common;
using Shop.Api.Common.Auth;
using Shop.Api.Common.Security;
using Shop.Api.Modules.Users.Dtos;

namespace Shop.Api.Modules.Users;

[ApiController]
[Route(ApiRoutes.V1 + "/auth")]
public class AuthController : ControllerBase
{
    private readonly UsersService _usersService;
    private readonly ICurrentUser _currentUser;

    public AuthController(UsersService usersService, ICurrentUser currentUser)
    {
        _usersService = usersService;
        _currentUser = currentUser;
    }

    /// <summary>Creates a customer account.</summary>
    [HttpPost("register")]
    [ProducesResponseType<UserResponse>(StatusCodes.Status201Created)]
    public async Task<IActionResult> Register(RegisterRequest request, CancellationToken ct)
    {
        var user = await _usersService.RegisterAsync(request, ct);
        return CreatedAtAction(nameof(UsersController.GetById), "Users", new { id = user.Id }, user);
    }

    /// <summary>Returns a JWT. Send it as "Authorization: Bearer {token}".</summary>
    [HttpPost("login")]
    [EnableRateLimiting(RateLimitingSetup.LoginPolicy)]
    public Task<LoginResponse> Login(LoginRequest request, CancellationToken ct) =>
        _usersService.LoginAsync(request, ct);

    /// <summary>The logged-in user, read from the token.</summary>
    [Authorize]
    [HttpGet("me")]
    public Task<UserResponse> Me(CancellationToken ct) =>
        _usersService.GetByIdAsync(_currentUser.Id, ct);
}

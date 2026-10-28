using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Shop.Api.Common.Auth;
using Shop.Api.Common.Errors;
using Shop.Api.Modules.Users.Dtos;

namespace Shop.Api.Modules.Users;

public class UsersService
{
    // A real hash of a random password, checked when the email is unknown (see LoginAsync).
    private static readonly string DummyPasswordHash =
        new PasswordHasher<User>().HashPassword(new User(), Guid.NewGuid().ToString());

    private readonly UsersDbContext _db;
    private readonly IPasswordHasher<User> _passwordHasher;
    private readonly JwtTokenService _tokenService;

    public UsersService(UsersDbContext db, IPasswordHasher<User> passwordHasher, JwtTokenService tokenService)
    {
        _db = db;
        _passwordHasher = passwordHasher;
        _tokenService = tokenService;
    }

    /// <summary>Registration always creates a Customer.</summary>
    public Task<UserResponse> RegisterAsync(RegisterRequest request, CancellationToken ct) =>
        CreateUserAsync(request.Email, request.Password, Roles.Customer, ct);

    public async Task<LoginResponse> LoginAsync(LoginRequest request, CancellationToken ct)
    {
        var email = NormalizeEmail(request.Email);
        var user = await _db.Users.SingleOrDefaultAsync(u => u.Email == email, ct);

        // Verify a password even when the email is unknown, so both cases take the same time.
        // Otherwise a fast "401" would reveal that the email is not registered (timing attack).
        var result = _passwordHasher.VerifyHashedPassword(
            user ?? new User(), user?.PasswordHash ?? DummyPasswordHash, request.Password);

        // Same answer for "no such email" and "wrong password", so nobody can find out which emails are registered.
        if (user is null || result == PasswordVerificationResult.Failed)
        {
            throw new UnauthorizedException("Invalid email or password.");
        }

        var token = _tokenService.CreateToken(user.Id, user.Role);
        return new LoginResponse(token.Token, token.ExpiresAtUtc, user.Role);
    }

    public async Task<UserResponse> GetByIdAsync(Guid id, CancellationToken ct)
    {
        var user = await _db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == id, ct)
            ?? throw new NotFoundException("User not found.");
        return ToResponse(user);
    }

    public async Task<IReadOnlyList<UserResponse>> GetAllAsync(CancellationToken ct)
    {
        var users = await _db.Users.AsNoTracking().OrderBy(u => u.CreatedAt).ToListAsync(ct);
        return users.Select(ToResponse).ToList();
    }

    /// <summary>
    /// Creates the admin account from configuration if there is no admin yet. Called at startup.
    /// Returns false if the email already belongs to a customer.
    /// </summary>
    public async Task<bool> EnsureAdminAsync(string email, string password, CancellationToken ct)
    {
        if (await _db.Users.AnyAsync(u => u.Role == Roles.Admin, ct))
            return true;

        // Never promote an existing account: anyone could have registered this email first,
        // and promoting it would hand them admin rights with their own password.
        var normalizedEmail = NormalizeEmail(email);
        if (await _db.Users.AnyAsync(u => u.Email == normalizedEmail, ct))
            return false;

        await CreateUserAsync(email, password, Roles.Admin, ct);
        return true;
    }

    private async Task<UserResponse> CreateUserAsync(string rawEmail, string password, string role, CancellationToken ct)
    {
        var email = NormalizeEmail(rawEmail);

        if (await _db.Users.AnyAsync(u => u.Email == email, ct))
            throw new ConflictException("This email is already registered.");

        var user = new User
        {
            Id = Guid.NewGuid(),
            Email = email,
            Role = role,
            CreatedAt = DateTime.UtcNow,
        };
        user.PasswordHash = _passwordHasher.HashPassword(user, password); // salted hash, never the password itself

        _db.Users.Add(user);
        try
        {
            await _db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException e) when (e.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // Two registrations with the same email at the same moment: the unique index stops the second one.
            throw new ConflictException("This email is already registered.");
        }

        return ToResponse(user);
    }

    // The unique index is case-sensitive, so "Ali@x.com" and "ali@x.com" must become the same value.
    private static string NormalizeEmail(string email) => email.Trim().ToLowerInvariant();

    private static UserResponse ToResponse(User user) => new(user.Id, user.Email, user.Role, user.CreatedAt);
}

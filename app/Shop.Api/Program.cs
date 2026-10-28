using Shop.Api.Common.Auth;
using Shop.Api.Common.Errors;
using Shop.Api.Common.OpenApi;
using Shop.Api.Common.Security;
using Shop.Api.Modules.Notifications;
using Shop.Api.Modules.Orders;
using Shop.Api.Modules.Products;
using Shop.Api.Modules.Users;

var builder = WebApplication.CreateBuilder(args);

// Do not tell attackers which web server we run (removes the "Server: Kestrel" header).
builder.WebHost.ConfigureKestrel(options => options.AddServerHeader = false);

// Add services to the container.

builder.Services.AddControllers();
builder.Services.AddApiDocs();
builder.Services.AddApiErrorHandling();
builder.Services.AddJwtAuth(builder.Configuration);

builder.Services.AddNotificationsModule(builder.Configuration);
builder.Services.AddOrdersModule(builder.Configuration);
builder.Services.AddProductsModule(builder.Configuration);
builder.Services.AddUsersModule(builder.Configuration);

var app = builder.Build();

// Configure the HTTP request pipeline.

// Before everything else, so even error responses get the security headers.
app.UseSecurityHeaders();

// First, so it catches exceptions thrown by everything after it.
app.UseExceptionHandler();
// Empty error responses (401, 403, 404, ...) also get a Problem Details body.
app.UseStatusCodePages();

// API docs only in Development: in production they would show attackers every endpoint.
if (app.Environment.IsDevelopment())
{
    app.UseApiDocs();
}

app.UseHttpsRedirection();

// Authentication (who are you?) must come before Authorization (are you allowed?).
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();

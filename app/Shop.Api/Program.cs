using Shop.Api.Common.Errors;
using Shop.Api.Common.OpenApi;
using Shop.Api.Modules.Notifications;
using Shop.Api.Modules.Orders;
using Shop.Api.Modules.Products;
using Shop.Api.Modules.Users;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.

builder.Services.AddControllers();
builder.Services.AddApiDocs();
builder.Services.AddApiErrorHandling();

builder.Services.AddNotificationsModule(builder.Configuration);
builder.Services.AddOrdersModule(builder.Configuration);
builder.Services.AddProductsModule(builder.Configuration);
builder.Services.AddUsersModule(builder.Configuration);

var app = builder.Build();

// Configure the HTTP request pipeline.

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

app.UseAuthorization();

app.MapControllers();

app.Run();

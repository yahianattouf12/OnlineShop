using Microsoft.EntityFrameworkCore;
using Shop.Api.Common.Data;
using Shop.Api.Common.Storage;
using Shop.Api.Modules.Products.Contracts;


namespace Shop.Api.Modules.Products;

public static class ProductsModule
{
    public static IServiceCollection AddProductsModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddDbContext<ProductsDbContext>(options =>
        {
            options.UseNpgsql(
                configuration.GetConnectionString("Default"),
                npgsqlOptions =>
                {
                    npgsqlOptions.MigrationsHistoryTable(
                        "__EFMigrationsHistory",
                        "products");
                });
        });

        services.AddHostedService<DatabaseMigrator<ProductsDbContext>>();
        services.AddScoped<ProductsService>();

        // Requirement 3: Redis, only when it is configured (docker-compose.cache.yml sets Redis__Configuration).
        // Without it, IDistributedCache is not registered, ProductsService gets null and reads the database:
        // that is our "before" measurement.
        var redis = configuration["Redis:Configuration"];
        if (!string.IsNullOrWhiteSpace(redis))
        {
            services.AddStackExchangeRedisCache(options =>
            {
                options.Configuration = redis;
                options.InstanceName = "shop:"; // a prefix for all our keys, e.g. shop:products:details:<id>
            });
        }

        // The only thing other modules may use from this module.
        services.AddScoped<IProductCatalog, ProductCatalog>();


        services.Configure<StorageOptions>(configuration.GetSection(StorageOptions.SectionName));
        services.AddSingleton<IImageStorage, LocalImageStorage>();

        return services;
    }
}

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
        
        // The only thing other modules may use from this module.
        services.AddScoped<IProductCatalog, ProductCatalog>();


        services.Configure<StorageOptions>(configuration.GetSection(StorageOptions.SectionName));
        services.AddSingleton<IImageStorage, LocalImageStorage>();

        return services;
    }
}

using Microsoft.EntityFrameworkCore;

namespace Shop.Api.Modules.Products;

public class ProductsDbContext : DbContext
{
    public DbSet<Product> Products { get; set; }

    public ProductsDbContext(DbContextOptions<ProductsDbContext> options) : base(options)
    {
    }

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        base.OnModelCreating(modelBuilder);

        modelBuilder.HasDefaultSchema("products");
        modelBuilder.Entity<Product>(entity =>
        {
            entity.HasKey(e => e.Id);
            entity.Property(e => e.Name).HasMaxLength(200);
            entity.Property(e => e.Description).HasMaxLength(2000);
            entity.Property(e => e.Price).HasPrecision(10, 2);
            entity.Property(e => e.Category).HasMaxLength(50);
            entity.Property(e => e.ImageFileName).HasMaxLength(100);
            entity.Property(e => e.ImageContentType).HasMaxLength(50);

            // Filtering by category and sorting by date are the common queries.
            entity.HasIndex(e => e.Category);
            entity.HasIndex(e => e.CreatedAt);
        });
    }
}

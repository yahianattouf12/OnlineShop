using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Shop.Api.Modules.Orders.Migrations
{
    /// <inheritdoc />
    public partial class AddOrdersCreatedAtIdIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_Orders_CreatedAt_Id",
                schema: "orders",
                table: "Orders",
                columns: new[] { "CreatedAt", "Id" },
                descending: new[] { true, false });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Orders_CreatedAt_Id",
                schema: "orders",
                table: "Orders");
        }
    }
}
